#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const hookDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(hookDir, '..', '..');
const cliPath = join(repoDir, 'src', 'cli.js');
const workdir = resolve(process.env.ACE_HOOK_WORKDIR || process.cwd());
const compact = process.env.ACE_HOOK_COMPACT || '8k';
const aceDir = join(workdir, '.ace');

function main() {
  mkdirSync(aceDir, { recursive: true });

  const experience = runNode([
    cliPath,
    'experience',
    '--json',
    '--workdir',
    workdir,
  ]);
  if (experience.stdout) {
    writeFileSync(join(aceDir, 'codex-experience.json'), experience.stdout);
  }

  const brief = runNode([
    cliPath,
    'brief',
    '--compact',
    compact,
    '--workdir',
    workdir,
  ]);

  writeFileSync(join(aceDir, 'codex-hook-status.json'), JSON.stringify({
    schema: 'ace.codex-hook-status.v1',
    generatedAt: new Date().toISOString(),
    ok: experience.exitCode === 0 && brief.exitCode === 0,
    commands: {
      experience: commandStatus(experience),
      brief: commandStatus(brief),
    },
  }, null, 2));

  if (experience.exitCode !== 0 || brief.exitCode !== 0) {
    process.stderr.write(
      experience.stderr
      || brief.stderr
      || experience.stdout
      || brief.stdout
      || 'ACE hook warning\n',
    );
  }
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      CI: process.env.CI || '1',
    },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function commandStatus(result) {
  return {
    exitCode: result.exitCode,
    stderr: result.stderr ? result.stderr.slice(0, 4000) : '',
    stdoutBytes: Buffer.byteLength(result.stdout || '', 'utf-8'),
  };
}

try {
  main();
} catch (error) {
  process.stderr.write(`ACE hook warning: ${error.message}\n`);
}

// Hooks should not block Codex from stopping; failed evidence remains a warning.
process.exit(0);
