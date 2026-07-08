import { test } from 'node:test';
import assert from 'node:assert';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { delimiter, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  formatInitSummary,
  initProject,
} from '../src/init.js';

function tempProject() {
  return mkdtempSync(join(tmpdir(), 'ace-init-'));
}

test('init creates agent instructions and config without overwriting by default', () => {
  const workdir = tempProject();
  const agentsPath = join(workdir, 'AGENTS.md');
  writeFileSync(agentsPath, '# Existing Instructions\n');

  const result = initProject({ workdir });
  const byRole = new Map(result.files.map((file) => [file.role, file]));

  assert.strictEqual(result.schema, 'ace.init.v1');
  assert.ok(existsSync(join(workdir, '.ace')));
  assert.ok(existsSync(join(workdir, 'ace.config.json')));
  assert.match(readFileSync(join(workdir, '.gitignore'), 'utf-8'), /^\.ace\/$/m);
  assert.strictEqual(byRole.get('agent-instructions').status, 'skipped-existing');
  assert.strictEqual(readFileSync(agentsPath, 'utf-8'), '# Existing Instructions\n');
});

test('init appends .ace to an existing gitignore without overwriting entries', () => {
  const workdir = tempProject();
  const gitignorePath = join(workdir, '.gitignore');
  writeFileSync(gitignorePath, 'node_modules/\n');

  const result = initProject({ workdir });
  const byRole = new Map(result.files.map((file) => [file.role, file]));
  const gitignore = readFileSync(gitignorePath, 'utf-8');

  assert.strictEqual(byRole.get('local-artifact-ignore').status, 'updated');
  assert.match(gitignore, /^node_modules\/$/m);
  assert.match(gitignore, /^\.ace\/$/m);
});

test('init summary tells humans and agents the next workflow steps', () => {
  const workdir = tempProject();
  const result = initProject({ workdir });
  const summary = formatInitSummary(result);

  assert.match(summary, /ACE initialized/);
  assert.match(summary, /ace experience --json/);
  assert.match(readFileSync(join(workdir, 'AGENTS.md'), 'utf-8'), /ACE Experience Handoff/);
});

test('init --codex creates project-local MCP and hook config', () => {
  const workdir = tempProject();
  const result = initProject({ workdir, codex: true });
  const byRole = new Map(result.files.map((file) => [file.role, file]));
  const codexConfig = readFileSync(join(workdir, '.codex', 'config.toml'), 'utf-8');
  const hooksConfig = readFileSync(join(workdir, '.codex', 'hooks.json'), 'utf-8');
  const hook = readFileSync(join(workdir, '.codex', 'hooks', 'ace-stop-handoff.cjs'), 'utf-8');

  assert.strictEqual(byRole.get('codex-mcp-config').status, 'created');
  assert.match(codexConfig, /command = "ace-mcp"/);
  assert.match(codexConfig, /default_tools_approval_mode = "prompt"/);
  assert.match(codexConfig, /approval_mode = "auto"/);
  assert.match(hooksConfig, /ace-stop-handoff\.cjs/);
  assert.match(hook, /ACE_BIN/);
  assert.match(hook, /require\('fs'\)/);
  assert.match(hook, /aceDir/);
  assert.ok(result.nextSteps.some((step) => step.includes('Codex')));
});

test('generated Codex hook runs without module type warnings in non-ESM projects', () => {
  const workdir = tempProject();
  initProject({ workdir, codex: true });
  const binDir = join(workdir, 'bin');
  mkdirSync(binDir);
  const fakeAce = join(binDir, 'fake-ace.cjs');
  writeFileSync(fakeAce, [
    'const args = process.argv.slice(2);',
    'if (args[0] === "experience") {',
    '  process.stdout.write(JSON.stringify({ schema: "ace.experience-packet.v1" }));',
    '}',
    'process.exit(0);',
    '',
  ].join('\n'));

  const shimPath = process.platform === 'win32' ? join(binDir, 'ace.cmd') : join(binDir, 'ace');
  const shimText = process.platform === 'win32'
    ? '@echo off\r\nnode "%~dp0fake-ace.cjs" %*\r\n'
    : '#!/usr/bin/env sh\nnode "$(dirname "$0")/fake-ace.cjs" "$@"\n';
  writeFileSync(shimPath, shimText);
  chmodSync(shimPath, 0o755);

  const result = spawnSync(process.execPath, [join(workdir, '.codex', 'hooks', 'ace-stop-handoff.cjs')], {
    cwd: workdir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ACE_BIN: 'ace',
      ACE_HOOK_WORKDIR: workdir,
      PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
    },
  });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stderr, '');
  assert.doesNotMatch(result.stderr, /MODULE_TYPELESS_PACKAGE_JSON/);
  assert.strictEqual(
    JSON.parse(readFileSync(join(workdir, '.ace', 'codex-experience.json'), 'utf-8')).schema,
    'ace.experience-packet.v1',
  );
  assert.strictEqual(
    JSON.parse(readFileSync(join(workdir, '.ace', 'codex-hook-status.json'), 'utf-8')).ok,
    true,
  );
});
