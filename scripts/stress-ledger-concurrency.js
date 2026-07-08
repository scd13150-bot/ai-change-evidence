#!/usr/bin/env node
import { spawn } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const repoRoot = resolve(process.cwd());
const tempRoot = mkdtempSync(join(tmpdir(), 'ace-ledger-stress-'));
const targetDir = join(tempRoot, 'target-project');
const cliPath = join(repoRoot, 'src', 'cli.js');
const workerCount = Number(process.env.ACE_LEDGER_STRESS_WORKERS || 48);

async function main() {
  try {
    await runCli(['start', 'Concurrent ledger stress', '--reset', '--workdir', targetDir]);

    const workers = [];
    for (let index = 0; index < workerCount; index += 1) {
      workers.push(runCli(['note', `concurrent-note-${index}`, '--workdir', targetDir]));
    }
    await Promise.all(workers);

    const ledgerPath = join(targetDir, '.ace', 'ledger.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
    const entries = ledger.entries || [];
    const ids = entries.map((entry) => entry.id);
    const noteTexts = new Set(entries.filter((entry) => entry.kind === 'note').map((entry) => entry.text));
    const aceDirEntries = readdirSync(join(targetDir, '.ace'));

    assertEqual(entries.length, workerCount + 1, 'ledger entry count');
    assertEqual(new Set(ids).size, ids.length, 'unique ledger entry ids');
    for (let index = 0; index < workerCount; index += 1) {
      if (!noteTexts.has(`concurrent-note-${index}`)) {
        throw new Error(`Missing concurrent note ${index}`);
      }
    }
    if (aceDirEntries.some((name) => name.endsWith('.tmp'))) {
      throw new Error(`Temporary ledger files were left behind: ${aceDirEntries.join(', ')}`);
    }
    if (aceDirEntries.includes('ledger.lock')) {
      throw new Error('Ledger lock was left behind after concurrent writes.');
    }

    console.log(`Ledger concurrency stress passed: ${workerCount} parallel note writers, no lost entries or lock/tmp residue.`);
  } finally {
    cleanupTempRoot();
  }
}

function runCli(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error([
        `Command failed (${code}): node ${cliPath} ${args.join(' ')}`,
        stderr,
        stdout,
      ].filter(Boolean).join('\n')));
    });
  });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function cleanupTempRoot() {
  if (process.env.ACE_KEEP_SMOKE_TEMP) {
    console.log(`Kept ledger stress temp directory: ${tempRoot}`);
    return;
  }
  const resolved = resolve(tempRoot);
  const temp = resolve(tmpdir());
  if (!resolved.startsWith(temp) || !resolved.includes('ace-ledger-stress-')) {
    throw new Error(`Refusing to remove unexpected temp directory: ${resolved}`);
  }
  if (existsSync(resolved)) removeTreeWithRetries(resolved);
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

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
