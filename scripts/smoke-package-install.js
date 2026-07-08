#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const repoRoot = resolve(process.cwd());
const tempRoot = mkdtempSync(join(tmpdir(), 'ace-package-smoke-'));
const packDir = join(tempRoot, 'pack');
const consumerDir = join(tempRoot, 'consumer');
const targetDir = join(tempRoot, 'target-project');
const isWindows = process.platform === 'win32';

function main() {
  try {
    mkdirSync(packDir, { recursive: true });
    mkdirSync(consumerDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    setupGitProject(targetDir);
    const packResult = run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: repoRoot, quiet: true });
    const packed = parsePackJson(packResult.stdout);
    const filename = packed[0]?.filename;
    if (!filename) throw new Error('npm pack did not report a tarball filename.');
    const tarballPath = join(packDir, filename);
    assertExists(tarballPath, 'packed tarball');

    run('npm', ['init', '-y'], { cwd: consumerDir, quiet: true });
    run('npm', ['install', '--ignore-scripts', '--no-package-lock', tarballPath], { cwd: consumerDir, quiet: true });

    const aceBin = binPath('ace');
    const aceMcpBin = binPath('ace-mcp');
    assertExists(aceBin, 'installed ace bin');
    assertExists(aceMcpBin, 'installed ace-mcp bin');

    const help = run(aceBin, ['help'], { cwd: consumerDir, quiet: true });
    assertIncludes(help.stdout, 'engineering experience handoff', 'ace help output');

    run(aceBin, ['init', '--codex', '--workdir', targetDir], { cwd: consumerDir, quiet: true });
    assertExists(join(targetDir, 'AGENTS.md'), 'generated AGENTS.md');
    assertIncludes(readFileSync(join(targetDir, '.gitignore'), 'utf-8'), '.ace/', 'generated .gitignore');
    assertExists(join(targetDir, '.codex', 'config.toml'), 'generated Codex config');
    assertExists(join(targetDir, '.codex', 'hooks', 'ace-stop-handoff.cjs'), 'generated Codex hook');

    const codexConfig = readFileSync(join(targetDir, '.codex', 'config.toml'), 'utf-8');
    assertIncludes(codexConfig, 'command = "ace-mcp"', 'generated Codex config');
    assertIncludes(codexConfig, toSlashPath(targetDir), 'generated Codex config cwd');
    assertIncludes(codexConfig, 'default_tools_approval_mode = "prompt"', 'generated Codex approval mode');

    const experience = run(aceBin, ['experience', '--json', '--no-evidence', '--workdir', targetDir], { cwd: consumerDir, quiet: true });
    const packet = JSON.parse(experience.stdout);
    if (packet.schema !== 'ace.experience-packet.v1') {
      throw new Error(`Unexpected experience schema: ${packet.schema}`);
    }

    writeFileSync(join(targetDir, 'src', 'app.js'), 'export const value = 2;\n');
    run(aceBin, ['start', 'Package install ledger evidence smoke', '--reset', '--workdir', targetDir], { cwd: consumerDir, quiet: true });
    run(aceBin, ['run', 'npm', 'test', '--workdir', targetDir], { cwd: consumerDir, quiet: true });
    const evidenceExperience = run(aceBin, ['experience', '--json', '--workdir', targetDir], { cwd: consumerDir, quiet: true });
    assertLedgerCommandEvidence(JSON.parse(evidenceExperience.stdout));
    const brief = run(aceBin, ['brief', '--compact', '4k', '--print', '--workdir', targetDir], { cwd: consumerDir, quiet: true });
    if (/Missing evidence:.*(command-output|test-output)/.test(brief.stdout)) {
      throw new Error('Handoff brief still reports command/test evidence missing after ace run.');
    }

    const mcp = run(aceMcpBin, [], {
      cwd: targetDir,
      input: mcpFrame({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      quiet: true,
    });
    assertIncludes(mcp.stdout, 'ace_experience', 'MCP tools/list output');
    assertIncludes(mcp.stdout, 'ace_run', 'MCP tools/list output');

    run(process.execPath, [join(targetDir, '.codex', 'hooks', 'ace-stop-handoff.cjs')], {
      cwd: targetDir,
      quiet: true,
      env: {
        ...process.env,
        ACE_BIN: aceBin,
        ACE_HOOK_WORKDIR: targetDir,
      },
    });
    assertExists(join(targetDir, '.ace', 'codex-experience.json'), 'Codex hook experience output');
    assertExists(join(targetDir, '.ace', 'codex-hook-status.json'), 'Codex hook status output');
    assertExists(join(targetDir, '.ace', 'handoff.md'), 'Codex hook handoff output');
    if (!JSON.parse(readFileSync(join(targetDir, '.ace', 'codex-hook-status.json'), 'utf-8')).ok) {
      throw new Error('Codex hook status did not report ok.');
    }

    console.log(`Package install smoke passed: ${filename}`);
  } finally {
    if (process.env.ACE_KEEP_SMOKE_TEMP) {
      console.log(`Kept smoke temp directory: ${tempRoot}`);
    } else {
      cleanupTempRoot();
    }
  }
}

function setupGitProject(projectDir) {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  mkdirSync(join(projectDir, 'tests'), { recursive: true });
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: {
      test: 'node tests/pass.test.js',
    },
  }, null, 2));
  writeFileSync(join(projectDir, 'src', 'app.js'), 'export const value = 1;\n');
  writeFileSync(join(projectDir, 'tests', 'pass.test.js'), [
    'import assert from "node:assert";',
    'assert.strictEqual(1, 1);',
    '',
  ].join('\n'));
  run('git', ['init'], { cwd: projectDir, quiet: true });
  run('git', ['config', 'user.email', 'ace@example.test'], { cwd: projectDir, quiet: true });
  run('git', ['config', 'user.name', 'ACE Smoke'], { cwd: projectDir, quiet: true });
  run('git', ['add', '.'], { cwd: projectDir, quiet: true });
  run('git', ['commit', '-m', 'init'], { cwd: projectDir, quiet: true });
}

function assertLedgerCommandEvidence(packet) {
  const riskIds = packet.experienceSummary?.riskSignals || [];
  const missingIds = (packet.missingEvidence || []).map((item) => item.id);
  if (riskIds.includes('no-command-evidence')) {
    throw new Error('Experience packet still reports no-command-evidence after ace run.');
  }
  if (missingIds.includes('command-output')) {
    throw new Error('Experience packet still reports command-output missing after ace run.');
  }
  if (missingIds.includes('test-output')) {
    throw new Error('Experience packet still reports test-output missing after ace run.');
  }
  if (packet.validation?.state !== 'passed' || packet.validation?.passed < 1) {
    throw new Error('Experience packet did not preserve passed ace run validation evidence.');
  }
}

function run(command, args, options = {}) {
  const cwd = options.cwd || repoRoot;
  ensureDir(cwd);
  const spawnTarget = commandTarget(command, args);
  const result = spawnSync(spawnTarget.command, spawnTarget.args, {
    cwd,
    input: options.input,
    encoding: 'utf-8',
    env: options.env || process.env,
    windowsHide: true,
  });
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    throw new Error([
      `Command failed (${exitCode}): ${command} ${args.join(' ')}`,
      result.error?.message,
      result.stderr,
      result.stdout,
    ].filter(Boolean).join('\n'));
  }
  if (!options.quiet && result.stdout.trim()) process.stdout.write(result.stdout);
  if (!options.quiet && result.stderr.trim()) process.stderr.write(result.stderr);
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function commandTarget(command, args) {
  if (!isWindows || !needsCmd(command)) {
    return { command, args };
  }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', [command, ...args].map(quoteCmdArg).join(' ')],
  };
}

function needsCmd(command) {
  const lower = String(command || '').toLowerCase();
  return lower === 'npm' || lower.endsWith('.cmd') || lower.endsWith('.bat');
}

function quoteCmdArg(value) {
  const text = String(value);
  if (!/[ \t"&|<>^]/.test(text)) return text;
  return `"${text.replace(/(["&|<>^])/g, '^$1')}"`;
}

function parsePackJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not parse npm pack JSON output: ${text}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

function binPath(name) {
  return join(consumerDir, 'node_modules', '.bin', isWindows ? `${name}.cmd` : name);
}

function assertExists(path, label) {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
}

function assertIncludes(text, expected, label) {
  if (!String(text).includes(expected)) {
    throw new Error(`${label} did not include expected text: ${expected}`);
  }
}

function mcpFrame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`;
}

function ensureDir(path) {
  const resolved = resolve(path);
  if (!resolved.startsWith(resolve(tempRoot)) && resolved !== repoRoot) {
    throw new Error(`Refusing to create unexpected directory: ${resolved}`);
  }
  mkdirSync(resolved, { recursive: true });
}

function cleanupTempRoot() {
  const resolved = resolve(tempRoot);
  const temp = resolve(tmpdir());
  if (!resolved.startsWith(temp) || !resolved.includes('ace-package-smoke-')) {
    throw new Error(`Refusing to remove unexpected temp directory: ${resolved}`);
  }
  removeTreeWithRetries(resolved);
}

function removeTreeWithRetries(path) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isTransientRemoveError(error) || attempt === 7) throw error;
      sleepSync(50 * (attempt + 1));
    }
  }
}

function isTransientRemoveError(error) {
  return ['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(error?.code);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function toSlashPath(path) {
  return String(path || '').replace(/\\/g, '/');
}

main();
