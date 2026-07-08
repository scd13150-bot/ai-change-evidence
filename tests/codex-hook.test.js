import { test } from 'node:test';
import assert from 'node:assert';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

function tempProject() {
  return mkdtempSync(join(tmpdir(), 'ace-codex-hook-'));
}

test('codex stop hook writes an ACE experience handoff', () => {
  const workdir = tempProject();
  const result = spawnSync(process.execPath, ['.codex/hooks/ace-stop-handoff.js'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      ACE_HOOK_WORKDIR: workdir,
    },
  });
  const experiencePath = join(workdir, '.ace', 'codex-experience.json');
  const handoffPath = join(workdir, '.ace', 'handoff.md');

  assert.strictEqual(result.status, 0);
  assert.ok(existsSync(experiencePath));
  assert.ok(existsSync(handoffPath));
  assert.strictEqual(JSON.parse(readFileSync(experiencePath, 'utf-8')).schema, 'ace.experience-packet.v1');
});
