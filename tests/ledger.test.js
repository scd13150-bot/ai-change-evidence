import { test } from 'node:test';
import assert from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendNote,
  buildAgentContext,
  buildExperiencePacket,
  buildFailureSignature,
  buildHandoffBrief,
  formatStatus,
  readLedger,
  recordCommand,
  startLedger,
} from '../src/ledger.js';

function tempProject() {
  return mkdtempSync(join(tmpdir(), 'ace-ledger-'));
}

test('ledger records objective and notes for an AI coding attempt', () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Fix export flow', reset: true });
  appendNote({ workdir, text: 'Tried wasm path rewrite; do not repeat without package export evidence.' });
  const ledger = readLedger(workdir);

  assert.strictEqual(ledger.objective, 'Fix export flow');
  assert.strictEqual(ledger.entries.length, 2);
  assert.strictEqual(ledger.entries[1].kind, 'note');
  assert.ok(ledger.entries[1].tags.includes('do-not-repeat'));
});

test('ledger tags Chinese do-not-repeat warnings', () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Fix export flow', reset: true });
  appendNote({
    workdir,
    text: '\u4e0d\u8981\u518d\u5220\u9664 renderer adapter; build already failed.',
  });
  const ledger = readLedger(workdir);

  assert.ok(ledger.entries[1].tags.includes('do-not-repeat'));
});

test('failure signatures normalize unstable paths and line numbers', () => {
  const signature = buildFailureSignature('npm test', {
    exitCode: 1,
    timedOut: false,
    stderr: 'Error: failed at D:\\repo\\src\\app.js:123:45',
    stdout: '',
  });

  assert.match(signature, /^npm test:Error: failed at <path>/);
  assert.ok(!signature.includes('123'));
});

test('recordCommand stores command result and status summarizes it', async () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Run smoke', reset: true });

  const { entry } = await recordCommand({
    workdir,
    command: 'node --version',
  });
  const ledger = readLedger(workdir);
  const status = formatStatus(ledger);

  assert.strictEqual(entry.kind, 'command');
  assert.strictEqual(entry.exitCode, 0);
  assert.match(status, /1 passed, 0 failed/);
});

test('run policy allowlist and denylist block unsafe command execution', async () => {
  const workdir = tempProject();
  writeFileSync(join(workdir, 'ace.config.json'), JSON.stringify({
    runPolicy: {
      allow: ['node --version', 'node -e "process.exit(0)"'],
      deny: ['node -e *blocked*'],
    },
  }, null, 2));
  startLedger({ workdir, objective: 'Run policy smoke', reset: true });

  await recordCommand({
    workdir,
    command: 'node --version',
  });
  await assert.rejects(
    () => recordCommand({ workdir, command: 'npm test' }),
    /matched no allow pattern/,
  );
  await assert.rejects(
    () => recordCommand({ workdir, command: 'node -e "console.log(\'blocked\')"' }),
    /deny pattern/,
  );

  const ledger = readLedger(workdir);
  const commands = ledger.entries.filter((entry) => entry.kind === 'command');
  assert.strictEqual(commands.length, 1);
  assert.strictEqual(commands[0].command, 'node --version');
});

test('later matching command pass resolves prior validation failure', async () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Resolve validation failure', reset: true });
  const command = 'node -e "process.exit(require(\'fs\').existsSync(\'pass.flag\') ? 0 : 1)" test';

  await recordCommand({ workdir, command });
  writeFileSync(join(workdir, 'pass.flag'), 'ok\n');
  await recordCommand({ workdir, command });

  const packet = buildExperiencePacket({ ledger: readLedger(workdir) });
  const status = formatStatus(readLedger(workdir));

  assert.strictEqual(packet.validation.state, 'passed');
  assert.strictEqual(packet.validation.unresolvedFailures, 0);
  assert.strictEqual(packet.validation.resolvedFailures, 1);
  assert.strictEqual(packet.experienceSummary.status, 'validated-so-far');
  assert.strictEqual(packet.state.latestFailure, null);
  assert.ok(packet.state.latestHistoricalFailure);
  assert.match(status, /0 unresolved/);
});

test('new objective starts a fresh active task without old failure pollution', async () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Old failed task', reset: true });
  appendNote({ workdir, text: 'Do not repeat old failed path.' });
  await recordCommand({
    workdir,
    command: 'node -e "process.exit(9)"',
  });

  startLedger({ workdir, objective: 'New task boundary' });
  const ledger = readLedger(workdir);
  const packet = buildExperiencePacket({ ledger });
  const brief = buildHandoffBrief({ ledger, compactBudget: '8k' });

  assert.ok(ledger.entries.length > packet.state.entries);
  assert.strictEqual(packet.objective, 'New task boundary');
  assert.strictEqual(packet.validation.state, 'not-run');
  assert.strictEqual(packet.experienceSummary.status, 'needs-validation');
  assert.strictEqual(packet.validation.failed, 0);
  assert.strictEqual(packet.validation.unresolvedFailures, 0);
  assert.deepStrictEqual(packet.doNotRepeat, []);
  assert.doesNotMatch(brief, /old failed path/);
  assert.doesNotMatch(brief, /process\.exit\(9\)/);
});

test('resolved ledger failures do not create active failure-triage evidence', async () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Resolve validation evidence', reset: true });
  const command = 'node -e "process.exit(require(\'fs\').existsSync(\'pass.flag\') ? 0 : 1)" test';
  await recordCommand({ workdir, command });
  writeFileSync(join(workdir, 'pass.flag'), 'ok\n');
  await recordCommand({ workdir, command });

  const packet = buildExperiencePacket({
    ledger: readLedger(workdir),
    evidencePack: {
      changeSummary: { headline: '1 changed file across source: 1.' },
      changedFiles: {
        summary: { total: 1, byCategory: { source: 1 } },
        files: [
          { status: 'M', path: 'src/app.js', category: 'source', additions: 1, deletions: 0 },
        ],
      },
      riskSignals: [],
      missingEvidence: [],
      suggestedEvidenceToCollect: [{ id: 'run-tests', reason: 'Run tests.', commands: ['npm test'] }],
      executedCommands: [],
    },
  });
  const missingIds = packet.missingEvidence.map((item) => item.id);

  assert.strictEqual(packet.validation.state, 'passed');
  assert.strictEqual(packet.experienceSummary.status, 'validated-so-far');
  assert.ok(!packet.experienceSummary.riskSignals.includes('command-failure'));
  assert.ok(!missingIds.includes('failure-triage'));
});

test('recordCommand redacts secrets before writing command output', async () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Capture failing output', reset: true });

  await recordCommand({
    workdir,
    command: 'node -e "console.error(\'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\'); process.exit(1)"',
  });
  const ledger = readLedger(workdir);
  const command = ledger.entries.find((entry) => entry.kind === 'command');

  assert.match(command.stderr, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(ledger), /sk-abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(command.failureSignature, /abcdefghijklmnopqrstuvwxyz123456/);
});

test('corrupt ledger is backed up before returning an empty ledger', () => {
  const workdir = tempProject();
  mkdirSync(join(workdir, '.ace'), { recursive: true });
  writeFileSync(join(workdir, '.ace', 'ledger.json'), '{not-json');

  const ledger = readLedger(workdir);
  const backups = readdirSync(join(workdir, '.ace')).filter((name) => name.includes('.corrupt-'));

  assert.strictEqual(ledger.entries.length, 0);
  assert.ok(ledger.warnings.some((item) => item.includes('Could not parse ledger')));
  assert.strictEqual(backups.length, 1);
  assert.ok(existsSync(join(workdir, '.ace', backups[0])));
});

test('ledger entry ids remain unique for rapid writes', () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Unique ids', reset: true });
  for (let index = 0; index < 20; index += 1) {
    appendNote({ workdir, text: `note ${index}` });
  }
  const ids = readLedger(workdir).entries.map((entry) => entry.id);

  assert.strictEqual(new Set(ids).size, ids.length);
});

test('handoff brief tells the next AI what not to repeat', () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Repair renderer build', reset: true });
  appendNote({ workdir, text: 'Do not repeat deleting renderer adapter; build already failed.' });
  const ledger = readLedger(workdir);
  const brief = buildHandoffBrief({
    ledger,
    evidencePack: {
      changeSummary: { headline: '2 changed files across source: 2.' },
      changedFiles: {
        summary: { byCategory: { source: 2 } },
        files: [
          { status: 'M', path: 'src/render.js', category: 'source', additions: 3, deletions: 1 },
        ],
      },
      riskSignals: [{ id: 'source-without-tests' }],
      missingEvidence: [{ id: 'test-output' }],
    },
    compactBudget: '8k',
  });

  assert.match(brief, /ACE Handoff Brief/);
  assert.match(brief, /Do Not Repeat/);
  assert.match(brief, /deleting renderer adapter/);
  assert.match(brief, /2 changed files/);
});

test('handoff brief keeps failed command sections readable and compact', () => {
  const longCommand = `node -e "${'x'.repeat(1200)}"`;
  const ledger = {
    schema: 'ace.ledger.v1',
    projectDir: tempProject(),
    objective: 'Compact failed command',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    warnings: [],
    entries: [
      {
        id: 'objective-1',
        at: new Date().toISOString(),
        kind: 'objective',
        text: 'Compact failed command',
      },
      {
        id: 'command-1',
        at: new Date().toISOString(),
        kind: 'command',
        command: longCommand,
        validationKey: longCommand.toLowerCase(),
        exitCode: 1,
        timedOut: false,
        durationMs: 12,
        stdout: '',
        stderr: `Error: ${'y'.repeat(1000)}`,
        failureSignature: `node -e:Error ${'z'.repeat(1000)}`,
      },
    ],
  };

  const brief = buildHandoffBrief({ ledger, compactBudget: '8k' });

  assert.match(brief, /## Unresolved Failed Commands/);
  assert.match(brief, /## Historical Failed Commands/);
  assert.ok(!brief.includes('## Failed Commands\n\n## Unresolved Failed Commands'));
  assert.match(brief, /\.\.\.\[truncated\]/);
  assert.ok(brief.length < 2200);
});

test('experience packet gives AI a compact machine-readable handoff', () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Repair renderer build', reset: true });
  appendNote({ workdir, text: 'Do not repeat deleting renderer adapter; build already failed.' });
  const ledger = readLedger(workdir);
  const packet = buildExperiencePacket({
    ledger,
    evidenceError: 'not a git repository',
  });

  assert.strictEqual(packet.schema, 'ace.experience-packet.v1');
  assert.strictEqual(packet.role, 'engineering-experience-handoff');
  assert.strictEqual(packet.objective, 'Repair renderer build');
  assert.ok(packet.doNotRepeat.some((item) => item.includes('deleting renderer adapter')));
  assert.strictEqual(packet.evidence.status, 'unavailable');
  assert.ok(Array.isArray(packet.agentInstructions));
});

test('experience packet compiles validation, missing evidence, and semantic impact', async () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Repair renderer build', reset: true });
  appendNote({ workdir, text: 'Do not repeat deleting renderer adapter; build already failed.' });
  await recordCommand({
    workdir,
    command: 'node -e "process.exit(1)"',
  });
  const ledger = readLedger(workdir);
  const packet = buildExperiencePacket({
    ledger,
    evidencePack: {
      changeSummary: { headline: '1 changed file across source: 1.' },
      changedFiles: {
        summary: { byCategory: { source: 1 } },
        files: [
          { status: 'M', path: 'src/render.js', category: 'source', additions: 3, deletions: 1 },
        ],
      },
      riskSignals: [{ id: 'source-without-tests', severity: 'medium', message: 'Source changed without tests.' }],
      missingEvidence: [{
        id: 'test-output',
        severity: 'high',
        reason: 'Source changed, but no successful test command output was collected.',
        commands: ['npm test'],
      }],
      suggestedEvidenceToCollect: [{
        id: 'run-tests',
        reason: 'Run the nearest project test command.',
        commands: ['npm test'],
      }],
      semanticProfile: {
        status: 'enabled',
        strategy: 'bounded-static-semantic-index',
        scan: { indexedFiles: 12, maxFilesHit: false },
        impactSummary: { changedModules: 1, withDirectDependents: 1 },
        changedModules: [{
          path: 'src/render.js',
          role: 'runtime-source',
          indexed: true,
          directDependents: ['src/app.js'],
          relatedTests: ['tests/render.test.js'],
          impactedEntrypoints: ['src/index.js'],
          evidenceValue: 99,
        }],
      },
    },
  });

  assert.strictEqual(packet.experienceSummary.status, 'has-failed-validation');
  assert.strictEqual(packet.validation.state, 'failed');
  assert.ok(packet.invalidatedPaths.some((item) => item.kind === 'do-not-repeat-note'));
  assert.strictEqual(packet.missingEvidence[0].id, 'test-output');
  assert.strictEqual(packet.suggestedNextEvidence[0].commands[0], 'npm test');
  assert.strictEqual(packet.semanticImpact.status, 'enabled');
  assert.strictEqual(packet.semanticImpact.topChangedModules[0].path, 'src/render.js');
});

test('ledger command evidence closes missing command gaps in experience packets and briefs', async () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Validate source change', reset: true });
  await recordCommand({
    workdir,
    command: 'node -e "process.exit(0)" test',
  });
  const ledger = readLedger(workdir);
  const staleEvidencePack = {
    changeSummary: { headline: '1 changed file across source: 1.' },
    changedFiles: {
      summary: { total: 1, byCategory: { source: 1 } },
      files: [
        { status: 'M', path: 'src/app.js', category: 'source', additions: 1, deletions: 0 },
      ],
    },
    riskSignals: [{ id: 'no-command-evidence', severity: 'low', message: 'No validation command output was collected yet.' }],
    missingEvidence: [
      { id: 'test-output', severity: 'high', reason: 'No tests.', commands: ['npm test'] },
      { id: 'command-output', severity: 'medium', reason: 'No command output.', commands: ['npm test'] },
    ],
    suggestedEvidenceToCollect: [{
      id: 'run-tests',
      reason: 'Run tests.',
      commands: ['npm test'],
    }],
    executedCommands: [],
  };

  const packet = buildExperiencePacket({ ledger, evidencePack: staleEvidencePack });
  const brief = buildHandoffBrief({ ledger, evidencePack: staleEvidencePack });
  const missingIds = packet.missingEvidence.map((item) => item.id);

  assert.ok(!packet.experienceSummary.riskSignals.includes('no-command-evidence'));
  assert.ok(!missingIds.includes('test-output'));
  assert.ok(!missingIds.includes('command-output'));
  assert.doesNotMatch(brief, /Missing evidence: .*test-output/);
  assert.doesNotMatch(brief, /Missing evidence: .*command-output/);
});

test('ledger failing command evidence still requires failure triage', async () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Validate source change', reset: true });
  await recordCommand({
    workdir,
    command: 'node -e "process.exit(7)" test',
  });
  const ledger = readLedger(workdir);
  const evidencePack = {
    changeSummary: { headline: '1 changed file across source: 1.' },
    changedFiles: {
      summary: { total: 1, byCategory: { source: 1 } },
      files: [
        { status: 'M', path: 'src/app.js', category: 'source', additions: 1, deletions: 0 },
      ],
    },
    riskSignals: [{ id: 'no-command-evidence', severity: 'low', message: 'No validation command output was collected yet.' }],
    missingEvidence: [],
    suggestedEvidenceToCollect: [{ id: 'run-tests', reason: 'Run tests.', commands: ['npm test'] }],
    executedCommands: [],
  };

  const packet = buildExperiencePacket({ ledger, evidencePack });
  const missingIds = packet.missingEvidence.map((item) => item.id);

  assert.ok(packet.experienceSummary.riskSignals.includes('command-failure'));
  assert.ok(!packet.experienceSummary.riskSignals.includes('no-command-evidence'));
  assert.ok(missingIds.includes('failure-triage'));
  assert.ok(!missingIds.includes('command-output'));
});

test('agent context builder remains as a compatibility alias', () => {
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Repair renderer build', reset: true });
  const ledger = readLedger(workdir);
  const packet = buildAgentContext({ ledger });

  assert.strictEqual(packet.schema, 'ace.experience-packet.v1');
});
