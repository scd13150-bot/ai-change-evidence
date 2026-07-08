import { test } from 'node:test';
import assert from 'node:assert';
import {
  buildAvailableCommands,
  buildMissingEvidence,
  buildRecommendedPrompt,
  buildSuggestedEvidence,
  categorizeFile,
  estimateTokens,
  normalizeProjectConfig,
  parseCompactBudget,
  shouldIgnorePath,
  summarizeChange,
} from '../src/evidence.js';

function promptEvidenceJson(prompt) {
  const match = prompt.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, 'prompt should contain fenced JSON evidence');
  return JSON.parse(match[1]);
}

test('categorizes release automation separately from runtime source', () => {
  assert.strictEqual(categorizeFile('.github/workflows/release.yml'), 'ci');
  assert.strictEqual(categorizeFile('scripts/release-channel.js'), 'ci');
  assert.strictEqual(categorizeFile('src/render.js'), 'source');
  assert.strictEqual(categorizeFile('src/graph/blocks.js'), 'source');
  assert.strictEqual(categorizeFile('pnpm-lock.yaml'), 'config');
});

test('summarizes source changes without tests as an evidence trait', () => {
  const changedFiles = {
    summary: {
      total: 2,
      additions: 8,
      deletions: 2,
      byCategory: { source: 2 },
    },
    files: [],
  };

  const summary = summarizeChange(changedFiles);

  assert.ok(summary.traits.includes('source-without-tests'));
  assert.match(summary.headline, /source: 2/);
});

test('suggested evidence asks for existing project commands', () => {
  const changedFiles = {
    summary: {
      total: 2,
      additions: 8,
      deletions: 2,
      byCategory: { source: 1, test: 1 },
    },
    files: [],
  };
  const suggestions = buildSuggestedEvidence({
    changedFiles,
    packageProfile: { scripts: ['test', 'lint'] },
    availableCommands: [
      { family: 'test', command: 'npm run test' },
      { family: 'lint', command: 'npm run lint' },
    ],
  });
  const byId = new Map(suggestions.map((item) => [item.id, item]));

  assert.deepStrictEqual(byId.get('run-tests').commands, ['npm run test']);
  assert.deepStrictEqual(byId.get('run-lint').commands, ['npm run lint']);
});

test('recommended prompt tells AI to stay grounded in evidence', () => {
  const prompt = buildRecommendedPrompt({
    changeSummary: { headline: '1 changed file.', traits: ['source-without-tests'] },
    packageProfile: {
      name: 'demo',
      packageManager: 'npm',
      scriptFamilies: { test: ['test'] },
    },
    changedFiles: {
      files: [{ path: 'src/app.js', category: 'source', additions: 1, deletions: 0 }],
    },
    riskSignals: [{ id: 'source-without-tests', severity: 'medium', message: 'Source changed without tests.' }],
    missingEvidence: [{ id: 'test-output', severity: 'high', reason: 'No tests.', howToCollect: ['Run tests.'], commands: ['npm run test'] }],
    suggestedEvidenceToCollect: [{ id: 'run-tests', commands: ['npm run test'] }],
    executedCommands: [],
    openQuestionsForAI: ['What behavior changed?'],
  });

  assert.match(prompt, /Do not invent facts/);
  assert.match(prompt, /npm run test/);
  assert.match(prompt, /source-without-tests/);
  assert.match(prompt, /missingEvidence/);
});

test('config ignore patterns match generated evidence and dependency paths', () => {
  assert.ok(shouldIgnorePath('.ace/runs/1/evidence.json', ['.ace/**']));
  assert.ok(shouldIgnorePath('node_modules/pkg/index.js', ['node_modules/**']));
  assert.ok(shouldIgnorePath('debug.log', ['*.log']));
  assert.ok(!shouldIgnorePath('src/app.js', ['.ace/**', 'node_modules/**']));
});

test('preferred config commands are ranked before package scripts', () => {
  const config = normalizeProjectConfig({
    preferredCommands: [
      { id: 'focused-test', family: 'test', command: 'npm run test:changed' },
    ],
  });
  const commands = buildAvailableCommands({
    packageManager: 'npm',
    scripts: ['test', 'lint'],
  }, config);

  assert.strictEqual(commands[0].command, 'npm run test:changed');
  assert.strictEqual(commands[0].source, 'config');
});

test('config can set an evidence pack text budget', () => {
  const config = normalizeProjectConfig({
    limits: {
      maxPackBytes: 123456,
    },
  });

  assert.strictEqual(config.limits.maxPackBytes, 123456);
});

test('config can enable bounded semantic evidence by default', () => {
  const config = normalizeProjectConfig({
    semantic: {
      enabled: true,
    },
  });

  assert.strictEqual(config.semantic.enabled, true);
});

test('config can define ace_run allow and deny policy', () => {
  const config = normalizeProjectConfig({
    runPolicy: {
      allow: ['npm test', 'node --version'],
      deny: ['npm publish *'],
    },
  });

  assert.deepStrictEqual(config.runPolicy.allow, ['npm test', 'node --version']);
  assert.deepStrictEqual(config.runPolicy.deny, ['npm publish *']);
});

test('recommended prompt includes config profile instructions and response format', () => {
  const prompt = buildRecommendedPrompt({
    config: {
      source: 'file',
      ignorePatterns: ['.ace/**'],
      prompt: {
        profile: 'team-pre-push',
        instructions: ['Prefer missing-evidence questions before strong claims.'],
        responseFormat: ['Readiness call.', 'Missing evidence.'],
      },
    },
    changeSummary: { headline: '1 changed file.', traits: ['source-without-tests'] },
    packageProfile: {
      name: 'demo',
      packageManager: 'npm',
      scriptFamilies: { test: ['test'] },
    },
    changedFiles: {
      files: [{ path: 'src/app.js', category: 'source', additions: 1, deletions: 0 }],
    },
    riskSignals: [],
    missingEvidence: [],
    suggestedEvidenceToCollect: [],
    executedCommands: [],
    openQuestionsForAI: [],
  });

  assert.match(prompt, /Prompt profile: team-pre-push/);
  assert.match(prompt, /Prefer missing-evidence questions/);
  assert.match(prompt, /1\. Readiness call/);
});

test('compact budget accepts k suffixes and raw token counts', () => {
  assert.strictEqual(parseCompactBudget('8k'), 8000);
  assert.strictEqual(parseCompactBudget('20K'), 20000);
  assert.strictEqual(parseCompactBudget('20000'), 20000);
  assert.strictEqual(parseCompactBudget(null), null);
});

test('recommended prompt stays unmarked when compact budget is absent', () => {
  const prompt = buildRecommendedPrompt({
    changeSummary: { headline: '1 changed file.', traits: ['source-without-tests'] },
    packageProfile: {
      name: 'demo',
      packageManager: 'npm',
      scriptFamilies: { test: ['test'] },
    },
    changedFiles: {
      files: [{ path: 'src/app.js', category: 'source', additions: 1, deletions: 0 }],
    },
    diffSnippets: [{ path: 'src/app.js', kind: 'git-diff', truncated: false, text: '+console.log("demo");' }],
    riskSignals: [],
    missingEvidence: [],
    suggestedEvidenceToCollect: [],
    executedCommands: [],
    openQuestionsForAI: [],
  });
  const evidence = promptEvidenceJson(prompt);

  assert.strictEqual(evidence.compaction, undefined);
  assert.strictEqual(evidence.diffSnippets.length, 1);
});

test('compact prompt records omitted files and diff truncation', () => {
  const files = Array.from({ length: 120 }, (_, index) => ({
    status: 'M',
    path: `src/file-${String(index).padStart(3, '0')}.js`,
    category: 'source',
    additions: 10 + index,
    deletions: index % 3,
  }));
  const diffSnippets = files.map((file) => ({
    path: file.path,
    kind: 'git-diff',
    truncated: false,
    text: `diff --git a/${file.path} b/${file.path}\n${'+changed line\n'.repeat(200)}`,
  }));
  const prompt = buildRecommendedPrompt({
    changeSummary: { headline: '120 changed files.', traits: ['large-change'] },
    packageProfile: {
      name: 'demo',
      packageManager: 'npm',
      scriptFamilies: { test: ['test'] },
    },
    changedFiles: {
      files,
    },
    diffSnippets,
    riskSignals: [{ id: 'large-change', severity: 'medium', message: 'Large change.' }],
    missingEvidence: [],
    suggestedEvidenceToCollect: [],
    executedCommands: [],
    openQuestionsForAI: ['Can this be split?'],
  }, { compactBudget: '1k' });
  const evidence = promptEvidenceJson(prompt);

  assert.strictEqual(evidence.compaction.enabled, true);
  assert.strictEqual(evidence.compaction.budgetTokens, 1000);
  assert.ok(evidence.changedFiles.length < files.length);
  assert.ok(evidence.compaction.omitted.changedFiles > 0);
  assert.ok(
    evidence.compaction.omitted.diffSnippets > 0 || evidence.compaction.truncated.diffSnippets > 0,
  );
  assert.ok(evidence.compaction.estimatedTokens <= estimateTokens(prompt));
});

test('compact prompt prioritizes high-risk files over path order', () => {
  const prompt = buildRecommendedPrompt({
    changeSummary: { headline: '3 changed files.', traits: ['ci-or-release'] },
    packageProfile: {
      name: 'demo',
      packageManager: 'npm',
      scriptFamilies: {},
    },
    changedFiles: {
      files: [
        { status: 'M', path: 'zzz-notes.md', category: 'docs', additions: 100, deletions: 0 },
        { status: 'M', path: 'src/app.js', category: 'source', additions: 10, deletions: 0 },
        { status: 'M', path: '.github/workflows/release.yml', category: 'ci', additions: 2, deletions: 0 },
      ],
    },
    diffSnippets: [],
    riskSignals: [{ id: 'ci-or-release-surface', severity: 'high', message: 'Release surface changed.' }],
    missingEvidence: [],
    suggestedEvidenceToCollect: [],
    executedCommands: [],
    openQuestionsForAI: [],
  }, { compactBudget: '4k' });
  const evidence = promptEvidenceJson(prompt);

  assert.strictEqual(evidence.changedFiles[0].path, '.github/workflows/release.yml');
  assert.ok(evidence.changedFiles[0].selectionReason.includes('ci-surface'));
});

test('compact prompt shortens command output previews', () => {
  const prompt = buildRecommendedPrompt({
    changeSummary: { headline: '1 changed file.', traits: ['source-without-tests'] },
    packageProfile: {
      name: 'demo',
      packageManager: 'npm',
      scriptFamilies: { test: ['test'] },
    },
    changedFiles: {
      files: [{ status: 'M', path: 'src/app.js', category: 'source', additions: 1, deletions: 0 }],
    },
    diffSnippets: [{ path: 'src/app.js', kind: 'git-diff', truncated: false, text: '+changed\n' }],
    riskSignals: [],
    missingEvidence: [],
    suggestedEvidenceToCollect: [],
    executedCommands: [{
      command: 'npm test',
      exitCode: 0,
      timedOut: false,
      durationMs: 123,
      stdout: 'x'.repeat(5000),
      stderr: '',
    }],
    openQuestionsForAI: [],
  }, { compactBudget: '1k' });
  const evidence = promptEvidenceJson(prompt);

  assert.strictEqual(evidence.executedCommands.length, 1);
  assert.ok((evidence.executedCommands[0].stdoutPreview || '').length < 5000);
  assert.ok(evidence.compaction.truncated.commandOutputs > 0);
});

test('recommended prompt redacts command output and diff snippets', () => {
  const prompt = buildRecommendedPrompt({
    changeSummary: { headline: '1 changed file.', traits: ['source-without-tests'] },
    packageProfile: {
      name: 'demo',
      packageManager: 'npm',
      scriptFamilies: { test: ['test'] },
    },
    changedFiles: {
      files: [{ status: 'M', path: 'src/app.js', category: 'source', additions: 1, deletions: 0 }],
    },
    diffSnippets: [{
      path: 'src/app.js',
      kind: 'git-diff',
      truncated: false,
      text: '+const token = "sk-abcdefghijklmnopqrstuvwxyz123456";',
    }],
    riskSignals: [],
    missingEvidence: [],
    suggestedEvidenceToCollect: [],
    executedCommands: [{
      command: 'npm test',
      exitCode: 1,
      timedOut: false,
      durationMs: 123,
      stdout: '',
      stderr: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    }],
    openQuestionsForAI: [],
  });
  const evidence = promptEvidenceJson(prompt);

  assert.match(prompt, /\[REDACTED\]/);
  assert.doesNotMatch(prompt, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(prompt, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(evidence.diffSnippets[0].text, /\[REDACTED\]/);
  assert.match(evidence.executedCommands[0].stderrPreview, /\[REDACTED\]/);
});

test('missing evidence asks for test output when source changed', () => {
  const missing = buildMissingEvidence({
    changedFiles: {
      summary: {
        total: 1,
        additions: 5,
        deletions: 1,
        byCategory: { source: 1 },
      },
      files: [],
    },
    suggestedEvidence: [
      { id: 'run-tests', commands: ['npm run test'] },
      { id: 'run-lint', commands: ['npm run lint'] },
    ],
    executedCommands: [],
    riskSignals: [{ id: 'source-without-tests', severity: 'medium' }],
  });
  const byId = new Map(missing.map((item) => [item.id, item]));

  assert.strictEqual(byId.get('test-output').severity, 'high');
  assert.deepStrictEqual(byId.get('test-output').commands, ['npm run test']);
  assert.ok(byId.has('command-output'));
});

test('missing evidence is reduced when matching command output exists', () => {
  const missing = buildMissingEvidence({
    changedFiles: {
      summary: {
        total: 2,
        additions: 5,
        deletions: 1,
        byCategory: { source: 1, test: 1 },
      },
      files: [],
    },
    suggestedEvidence: [{ id: 'run-tests', commands: ['npm run test'] }],
    executedCommands: [{ command: 'npm run test', exitCode: 0 }],
    riskSignals: [],
  });

  assert.ok(!missing.some((item) => item.id === 'test-output'));
  assert.ok(!missing.some((item) => item.id === 'command-output'));
});

test('missing evidence captures visual and command failure gaps', () => {
  const missing = buildMissingEvidence({
    changedFiles: {
      summary: {
        total: 1,
        additions: 2,
        deletions: 0,
        byCategory: { visual: 1 },
      },
      files: [],
    },
    suggestedEvidence: [{ id: 'run-build', commands: ['npm run build'] }],
    executedCommands: [{ command: 'npm run build', exitCode: 1 }],
    riskSignals: [{ id: 'command-failure', severity: 'high' }],
  });
  const ids = missing.map((item) => item.id);

  assert.ok(ids.includes('visual-before-after'));
  assert.ok(ids.includes('failure-triage'));
});
