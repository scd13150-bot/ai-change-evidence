import { randomUUID } from 'crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import {
  augmentEvidenceWithCommandEvidence,
  loadProjectConfig,
  runProcess,
} from './evidence.js';
import { redactObject, redactText } from './redact.js';

const LEDGER_SCHEMA = 'ace.ledger.v1';
const DEFAULT_OUTPUT_BYTES = 12000;
const DEFAULT_TIMEOUT_MS = 120000;
const RECENT_ENTRY_LIMIT = 12;
const BRIEF_COMMAND_CHARS = 180;
const BRIEF_TEXT_CHARS = 240;
const BRIEF_PREVIEW_CHARS = 180;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;
const LOCK_POLL_MS = 25;

export function resolveProjectDir(workdir = null) {
  return resolve(workdir || process.cwd());
}

export function ledgerPath(projectDir) {
  return join(projectDir, '.ace', 'ledger.json');
}

export function handoffPath(projectDir) {
  return join(projectDir, '.ace', 'handoff.md');
}

export function readLedger(projectDir) {
  const path = ledgerPath(projectDir);
  if (!existsSync(path)) return createEmptyLedger(projectDir);

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed?.schema !== LEDGER_SCHEMA || !Array.isArray(parsed.entries)) {
      return createEmptyLedger(projectDir, [`Ignored incompatible ledger at ${path}`]);
    }
    const safeParsed = redactObject(parsed);
    return {
      ...safeParsed,
      projectDir,
      warnings: safeParsed.warnings || [],
    };
  } catch (error) {
    const backupPath = backupCorruptLedger(path);
    const backupText = backupPath ? ` Backed up corrupt ledger to ${backupPath}.` : '';
    return createEmptyLedger(projectDir, [`Could not parse ledger: ${error.message}.${backupText}`]);
  }
}

export function writeLedger(projectDir, ledger) {
  return withLedgerLock(projectDir, () => writeLedgerUnlocked(projectDir, ledger));
}

function writeLedgerUnlocked(projectDir, ledger) {
  const aceDir = join(projectDir, '.ace');
  mkdirSync(aceDir, { recursive: true });
  const path = ledgerPath(projectDir);
  const updated = redactObject({
    ...ledger,
    projectDir,
    updatedAt: new Date().toISOString(),
  });
  const tempPath = `${path}.${process.pid}.${makeEntryId()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(updated, null, 2));
  renameSync(tempPath, path);
  return path;
}

export function startLedger({ workdir = null, objective, reset = false }) {
  const projectDir = resolveProjectDir(workdir);
  let ledger = null;
  const path = withLedgerLock(projectDir, () => {
    const existing = reset ? createEmptyLedger(projectDir) : readLedger(projectDir);
    const taskId = makeEntryId();
    ledger = {
      ...existing,
      objective: cleanText(objective) || existing.objective || 'Unspecified AI coding task.',
      activeTaskId: taskId,
    };
    appendEntry(ledger, {
      kind: 'objective',
      text: ledger.objective,
      reset,
      taskId,
    });
    return writeLedgerUnlocked(projectDir, ledger);
  });
  return { ledger, path };
}

export function appendNote({ workdir = null, text, kind = 'note' }) {
  const projectDir = resolveProjectDir(workdir);
  let ledger = null;
  let entry = null;
  const path = withLedgerLock(projectDir, () => {
    ledger = readLedger(projectDir);
    entry = appendEntry(ledger, {
      kind,
      text: cleanText(text),
      tags: extractTags(text),
    });
    return writeLedgerUnlocked(projectDir, ledger);
  });
  return { ledger, entry, path };
}

export async function recordCommand({ workdir = null, command, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_OUTPUT_BYTES }) {
  const projectDir = resolveProjectDir(workdir);
  const startedAt = new Date().toISOString();
  const safeCommand = cleanText(command);
  assertCommandAllowed(projectDir, safeCommand);
  const result = await runProcess(command, [], {
    cwd: projectDir,
    shell: true,
    timeoutMs,
    maxOutputBytes,
  });
  const safeResult = sanitizeCommandResult(result);
  let ledger = null;
  let entry = null;
  const path = withLedgerLock(projectDir, () => {
    ledger = readLedger(projectDir);
    entry = appendEntry(ledger, {
      kind: 'command',
      command: safeCommand,
      validationKey: commandValidationKey(safeCommand),
      startedAt,
      exitCode: safeResult.exitCode,
      signal: safeResult.signal,
      timedOut: safeResult.timedOut,
      durationMs: safeResult.durationMs,
      stdout: safeResult.stdout,
      stderr: safeResult.stderr,
      stdoutTruncated: safeResult.stdoutTruncated,
      stderrTruncated: safeResult.stderrTruncated,
      failureSignature: safeResult.exitCode === 0 ? null : buildFailureSignature(safeCommand, safeResult),
    });
    return writeLedgerUnlocked(projectDir, ledger);
  });
  return { ledger, entry, path, result: safeResult };
}

export function summarizeLedger(ledger) {
  const entries = currentTaskEntries(ledger);
  const commands = entries.filter((entry) => entry.kind === 'command');
  const failedCommands = commands.filter((entry) => entry.exitCode !== 0);
  const validationSummary = summarizeValidationCommands(commands);
  const notes = entries.filter((entry) => entry.kind === 'note');
  const failuresBySignature = countBy(
    validationSummary.unresolvedFailures.map((entry) => entry.failureSignature).filter(Boolean),
  );
  const repeatedFailures = Object.entries(failuresBySignature)
    .filter(([, count]) => count > 1)
    .map(([signature, count]) => ({ signature, count }));

  return {
    objective: ledger.objective || 'Unspecified AI coding task.',
    entries: entries.length,
    notes: notes.length,
    commands: commands.length,
    failedCommands: failedCommands.length,
    passedCommands: commands.length - failedCommands.length,
    unresolvedFailedCommands: validationSummary.unresolvedFailures.length,
    resolvedFailedCommands: validationSummary.resolvedFailures.length,
    latestEntry: ledger.entries.at(-1) || null,
    latestCommand: commands.at(-1) || null,
    latestFailure: validationSummary.unresolvedFailures.at(-1) || null,
    latestHistoricalFailure: failedCommands.at(-1) || null,
    repeatedFailures,
    unresolvedFailureEntries: validationSummary.unresolvedFailures,
    resolvedFailureEntries: validationSummary.resolvedFailures,
  };
}

export function formatStatus(ledger) {
  const summary = summarizeLedger(ledger);
  const totalEntries = ledger.entries.length;
  const lines = [];
  lines.push(`ACE Ledger: ${ledger.projectDir}`);
  lines.push(`Objective: ${summary.objective}`);
  lines.push(`Entries: ${summary.entries} active (${totalEntries} total; ${summary.commands} commands, ${summary.notes} notes)`);
  lines.push(`Commands: ${summary.passedCommands} passed, ${summary.failedCommands} failed (${summary.unresolvedFailedCommands} unresolved)`);
  if (summary.latestFailure) {
    lines.push(`Latest unresolved failure: ${summary.latestFailure.command}`);
    lines.push(`Failure signature: ${summary.latestFailure.failureSignature}`);
  } else if (summary.latestHistoricalFailure) {
    lines.push(`Latest historical failure resolved by a later matching pass: ${summary.latestHistoricalFailure.command}`);
  }
  if (summary.repeatedFailures.length > 0) {
    lines.push('Repeated failures:');
    for (const item of summary.repeatedFailures.slice(0, 5)) {
      lines.push(`  - ${item.count}x ${item.signature}`);
    }
  }
  return lines.join('\n');
}

export function buildExperiencePacket({ ledger, evidencePack = null, evidenceError = null }) {
  const summary = summarizeLedger(ledger);
  const augmentedEvidencePack = evidencePackWithLedgerCommands(evidencePack, ledger);
  const entries = currentTaskEntries(ledger);
  const recentEntries = entries.slice(-RECENT_ENTRY_LIMIT);
  const failedCommands = entries
    .filter((entry) => entry.kind === 'command' && entry.exitCode !== 0)
    .slice(-8);
  const doNotRepeat = buildDoNotRepeat(ledger);
  const evidence = evidenceExperience(augmentedEvidencePack, evidenceError);

  return {
    schema: 'ace.experience-packet.v1',
    role: 'engineering-experience-handoff',
    supersedes: ['ace.agent-context.v1'],
    generatedAt: new Date().toISOString(),
    projectDir: ledger.projectDir,
    objective: summary.objective,
    experienceSummary: buildExperienceSummary({
      summary,
      doNotRepeat,
      evidence,
      evidencePack: augmentedEvidencePack,
    }),
    state: {
      entries: summary.entries,
      notes: summary.notes,
      commands: summary.commands,
      passedCommands: summary.passedCommands,
      failedCommands: summary.failedCommands,
      unresolvedFailedCommands: summary.unresolvedFailedCommands,
      resolvedFailedCommands: summary.resolvedFailedCommands,
      latestFailure: summary.latestFailure ? commandExperience(summary.latestFailure) : null,
      latestHistoricalFailure: summary.latestHistoricalFailure ? commandExperience(summary.latestHistoricalFailure) : null,
      repeatedFailures: summary.repeatedFailures,
    },
    recentTimeline: recentEntries.map(experienceTimelineEntry),
    failedCommands: failedCommands.map(commandExperience),
    unresolvedFailedCommands: summary.unresolvedFailureEntries.map(commandExperience).slice(-8),
    validation: validationExperience(summary, ledger),
    invalidatedPaths: invalidatedPathExperience(summary, doNotRepeat),
    doNotRepeat,
    evidence,
    missingEvidence: missingEvidenceExperience(augmentedEvidencePack),
    suggestedNextEvidence: suggestedNextEvidenceExperience(augmentedEvidencePack),
    semanticImpact: semanticImpactExperience(augmentedEvidencePack),
    agentInstructions: [
      'Read this experience packet before changing files.',
      'Treat it as transferred engineering experience, not as final truth.',
      'Do not repeat failed commands or approaches unless new evidence changes the inputs.',
      'Run validation through ace run so command results become durable evidence.',
      'Record abandoned paths with ace note, especially do-not-repeat warnings.',
      'Before handing off, run ace brief or ace experience --json for the next agent.',
    ],
  };
}

export function buildAgentContext(options) {
  return buildExperiencePacket(options);
}

export function buildHandoffBrief({ ledger, evidencePack = null, evidenceError = null, compactBudget = null }) {
  const summary = summarizeLedger(ledger);
  const augmentedEvidencePack = evidencePackWithLedgerCommands(evidencePack, ledger);
  const entries = currentTaskEntries(ledger);
  const recentEntries = entries.slice(-RECENT_ENTRY_LIMIT);
  const failedCommands = entries
    .filter((entry) => entry.kind === 'command' && entry.exitCode !== 0)
    .slice(-8);
  const unresolvedIds = new Set(summary.unresolvedFailureEntries.map((entry) => entry.id));
  const historicalFailedCommands = failedCommands.filter((entry) => !unresolvedIds.has(entry.id));
  const doNotRepeat = buildDoNotRepeat(ledger);
  const lines = [];

  lines.push('# ACE Handoff Brief');
  lines.push('');
  lines.push('Use this as the current task ledger. Do not repeat failed attempts unless new evidence justifies it.');
  lines.push('');
  lines.push('## Current Objective');
  lines.push('');
  lines.push(summary.objective);
  lines.push('');
  lines.push('## Current State');
  lines.push('');
  lines.push(`- Entries: ${summary.entries}`);
  lines.push(`- Commands: ${summary.passedCommands} passed, ${summary.failedCommands} failed`);
  if (compactBudget) lines.push(`- Prompt budget target: ${compactBudget}`);
  if (summary.latestFailure) {
    lines.push(`- Latest unresolved failure signature: ${compactText(summary.latestFailure.failureSignature, BRIEF_TEXT_CHARS)}`);
  }
  if (!summary.latestFailure && summary.latestHistoricalFailure) {
    lines.push(`- Historical failures resolved by later matching passes: ${summary.resolvedFailedCommands}`);
  }
  lines.push('');

  lines.push('## Recent Timeline');
  lines.push('');
  if (recentEntries.length === 0) {
    lines.push('- No entries recorded yet.');
  } else {
    for (const entry of recentEntries) lines.push(`- ${formatTimelineEntry(entry)}`);
  }
  lines.push('');

  lines.push('## Unresolved Failed Commands');
  lines.push('');
  if (summary.unresolvedFailureEntries.length === 0) {
    lines.push('- None currently unresolved.');
  } else {
    for (const entry of summary.unresolvedFailureEntries.slice(-8)) {
      appendBriefCommand(lines, entry);
    }
  }
  lines.push('');

  lines.push('## Historical Failed Commands');
  lines.push('');
  if (historicalFailedCommands.length === 0) {
    lines.push('- None recorded.');
  } else {
    for (const entry of historicalFailedCommands) {
      appendBriefCommand(lines, entry);
    }
  }
  lines.push('');

  lines.push('## Do Not Repeat');
  lines.push('');
  if (doNotRepeat.length === 0) {
    lines.push('- No repeated failure pattern recorded yet.');
  } else {
    for (const item of doNotRepeat) lines.push(`- ${compactText(item, BRIEF_TEXT_CHARS)}`);
  }
  lines.push('');

  lines.push('## Current Change Evidence');
  lines.push('');
  if (augmentedEvidencePack) {
    lines.push(`- Headline: ${augmentedEvidencePack.changeSummary.headline}`);
    lines.push(`- Categories: ${formatCountMap(augmentedEvidencePack.changedFiles.summary.byCategory) || 'none'}`);
    if (augmentedEvidencePack.riskSignals.length > 0) {
      lines.push(`- Risk signals: ${augmentedEvidencePack.riskSignals.map((item) => item.id).join(', ')}`);
    }
    if (augmentedEvidencePack.missingEvidence?.length > 0) {
      lines.push(`- Missing evidence: ${augmentedEvidencePack.missingEvidence.map((item) => item.id).join(', ')}`);
    }
    lines.push('- Highest-value changed files:');
    for (const file of augmentedEvidencePack.changedFiles.files.slice(0, 12)) {
      lines.push(`  - ${file.status} ${file.path} (${file.category}, +${file.additions}/-${file.deletions})`);
    }
  } else if (evidenceError) {
    lines.push(`- Current evidence unavailable: ${evidenceError}`);
  } else {
    lines.push('- Current evidence was not requested.');
  }
  lines.push('');

  lines.push('## Next AI Instructions');
  lines.push('');
  lines.push('- Continue from the latest objective and timeline, not from a blank slate.');
  lines.push('- Before proposing a fix, check failed commands and do-not-repeat items.');
  lines.push('- If evidence is missing, ask for or collect that evidence before making a strong readiness claim.');
  lines.push('- Keep the next step small enough to validate with one command or one focused inspection.');
  lines.push('');

  return lines.join('\n');
}

export function writeHandoffBrief(projectDir, brief, explicitOut = null) {
  const outPath = explicitOut ? resolve(explicitOut) : handoffPath(projectDir);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, brief);
  return outPath;
}

function evidencePackWithLedgerCommands(evidencePack, ledger) {
  if (!evidencePack) return evidencePack;
  const commands = currentTaskEntries(ledger).filter((entry) => entry.kind === 'command');
  const resolvedIds = new Set(summarizeValidationCommands(commands).resolvedFailures.map((item) => item.entry.id));
  const ledgerCommands = commands
    .filter((entry) => !resolvedIds.has(entry.id))
    .map(ledgerCommandToEvidenceCommand);
  return augmentEvidenceWithCommandEvidence(evidencePack, ledgerCommands);
}

function ledgerCommandToEvidenceCommand(entry) {
  return {
    source: 'ace-ledger',
    ledgerEntryId: entry.id,
    startedAt: entry.startedAt || entry.at || null,
    command: entry.command,
    exitCode: entry.exitCode,
    signal: entry.signal || null,
    timedOut: Boolean(entry.timedOut),
    durationMs: entry.durationMs || 0,
    stdout: entry.stdout || '',
    stderr: entry.stderr || '',
    stdoutTruncated: Boolean(entry.stdoutTruncated),
    stderrTruncated: Boolean(entry.stderrTruncated),
    failureSignature: entry.failureSignature || null,
  };
}

export function buildFailureSignature(command, result) {
  if (result.timedOut) return `timeout:${normalizeCommandName(command)}`;
  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !/^\[?\d+\/\d+\]?/.test(item));
  const normalized = normalizeFailureLine(line || `exit ${result.exitCode}`);
  return `${normalizeCommandName(command)}:${normalized}`;
}

function createEmptyLedger(projectDir, warnings = []) {
  const now = new Date().toISOString();
  return {
    schema: LEDGER_SCHEMA,
    projectDir,
    createdAt: now,
    updatedAt: now,
    objective: null,
    warnings,
    entries: [],
  };
}

function withLedgerLock(projectDir, action) {
  const aceDir = join(projectDir, '.ace');
  mkdirSync(aceDir, { recursive: true });
  const path = join(aceDir, 'ledger.lock');
  const fd = acquireLock(path);
  try {
    return action();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Ignore cleanup failures; the stale-lock path can recover.
    }
    try {
      unlinkSync(path);
    } catch {
      // Ignore cleanup failures; the stale-lock path can recover.
    }
  }
}

function acquireLock(path) {
  const started = Date.now();
  let lastError = null;
  while (true) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        at: new Date().toISOString(),
      }));
      return fd;
    } catch (error) {
      if (!isLockContentionError(error)) throw error;
      lastError = error;
      removeStaleLock(path);
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        const detail = lastError?.code ? ` Last error: ${lastError.code}.` : '';
        throw new Error(`Timed out waiting for ACE ledger lock: ${path}.${detail}`);
      }
      sleepSync(LOCK_POLL_MS + Math.floor(Math.random() * LOCK_POLL_MS));
    }
  }
}

function isLockContentionError(error) {
  return ['EEXIST', 'EACCES', 'EPERM'].includes(error?.code);
}

function removeStaleLock(path) {
  try {
    const ageMs = Date.now() - statSync(path).mtimeMs;
    if (ageMs > LOCK_STALE_MS) unlinkSync(path);
  } catch {
    // If the lock disappeared between attempts, the next open will succeed.
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function backupCorruptLedger(path) {
  if (!existsSync(path)) return null;
  const backupPath = `${path}.corrupt-${makeEntryId()}`;
  try {
    copyFileSync(path, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

function assertCommandAllowed(projectDir, command) {
  const policy = loadProjectConfig(projectDir).config.runPolicy;
  const deniedBy = findMatchingCommandPattern(command, policy.deny);
  if (deniedBy) {
    throw new Error(`ACE run policy blocked command by deny pattern: ${deniedBy}`);
  }
  if (policy.allow.length > 0 && !findMatchingCommandPattern(command, policy.allow)) {
    throw new Error('ACE run policy blocked command because it matched no allow pattern.');
  }
}

function findMatchingCommandPattern(command, patterns) {
  return (patterns || []).find((pattern) => commandMatchesPattern(command, pattern)) || null;
}

function commandMatchesPattern(command, pattern) {
  const normalizedCommand = normalizeCommandPatternText(command);
  const normalizedPattern = normalizeCommandPatternText(pattern);
  if (!normalizedPattern) return false;
  if (!normalizedPattern.includes('*')) return normalizedCommand === normalizedPattern;
  return wildcardPatternToRegExp(normalizedPattern).test(normalizedCommand);
}

function normalizeCommandPatternText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function wildcardPatternToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function appendEntry(ledger, entry) {
  const next = {
    id: makeEntryId(),
    at: new Date().toISOString(),
    ...(ledger.activeTaskId && !entry.taskId ? { taskId: ledger.activeTaskId } : {}),
    ...entry,
  };
  ledger.entries.push(next);
  return next;
}

function formatTimelineEntry(entry) {
  if (entry.kind === 'objective') return `objective: ${compactText(entry.text, BRIEF_TEXT_CHARS)}`;
  if (entry.kind === 'command') {
    const status = entry.exitCode === 0 ? 'PASS' : 'FAIL';
    return `${status} command: ${compactText(entry.command, BRIEF_COMMAND_CHARS)} (${entry.durationMs}ms)`;
  }
  return `${entry.kind}: ${compactText(entry.text, BRIEF_TEXT_CHARS)}`;
}

function experienceTimelineEntry(entry) {
  if (entry.kind === 'command') {
    return {
      id: entry.id,
      at: entry.at,
      kind: entry.kind,
      command: entry.command,
      status: entry.exitCode === 0 ? 'pass' : 'fail',
      exitCode: entry.exitCode,
      durationMs: entry.durationMs,
      failureSignature: entry.failureSignature || null,
    };
  }
  return {
    id: entry.id,
    at: entry.at,
    kind: entry.kind,
    text: entry.text || '',
    tags: entry.tags || [],
  };
}

function buildExperienceSummary({ summary, doNotRepeat, evidence, evidencePack }) {
  const highMissing = (evidencePack?.missingEvidence || []).filter((item) => item.severity === 'high').length;
  const riskSignals = evidencePack?.riskSignals || [];
  return {
    status: experienceStatus({ summary, highMissing, evidence }),
    entries: summary.entries,
    failedCommands: summary.failedCommands,
    passedCommands: summary.passedCommands,
    unresolvedFailedCommands: summary.unresolvedFailedCommands,
    resolvedFailedCommands: summary.resolvedFailedCommands,
    doNotRepeatItems: doNotRepeat.length,
    repeatedFailurePatterns: summary.repeatedFailures.length,
    evidenceStatus: evidence.status,
    highMissingEvidence: highMissing,
    riskSignals: riskSignals.map((item) => item.id).slice(0, 8),
    nextActionBias: nextActionBias({ summary, doNotRepeat, highMissing, evidence }),
  };
}

function experienceStatus({ summary, highMissing, evidence }) {
  if (summary.unresolvedFailedCommands > 0) return 'has-failed-validation';
  if (highMissing > 0) return 'missing-critical-evidence';
  if (evidence.status === 'unavailable') return 'ledger-only';
  if (summary.passedCommands > 0) return 'validated-so-far';
  return 'needs-validation';
}

function nextActionBias({ summary, doNotRepeat, highMissing, evidence }) {
  if (summary.latestFailure) return 'triage unresolved failure before proposing another fix';
  if (doNotRepeat.length > 0) return 'avoid invalidated approaches before editing';
  if (highMissing > 0) return 'collect high-severity missing evidence';
  if (evidence.status === 'unavailable') return 'continue from ledger and collect project evidence when possible';
  if (summary.passedCommands === 0) return 'run the smallest relevant validation command through ace run';
  return 'continue with the next small validated step';
}

function validationExperience(summary, ledger) {
  const commands = ledger.entries.filter((entry) => entry.kind === 'command');
  const unresolved = summary.unresolvedFailureEntries;
  const resolved = summary.resolvedFailureEntries;
  return {
    state: validationState(summary),
    commands: summary.commands,
    passed: summary.passedCommands,
    failed: summary.failedCommands,
    unresolvedFailures: summary.unresolvedFailedCommands,
    resolvedFailures: summary.resolvedFailedCommands,
    latestFailure: summary.latestFailure ? commandExperience(summary.latestFailure) : null,
    latestHistoricalFailure: summary.latestHistoricalFailure ? commandExperience(summary.latestHistoricalFailure) : null,
    unresolvedFailureSignatures: dedupeStrings(unresolved
      .map((entry) => entry.failureSignature)
      .filter(Boolean))
      .slice(0, 12),
    resolvedFailureSignatures: dedupeStrings(resolved
      .map((item) => item.entry.failureSignature)
      .filter(Boolean))
      .slice(0, 12),
    failureSignatures: dedupeStrings(commands
      .filter((entry) => entry.exitCode !== 0)
      .map((entry) => entry.failureSignature)
      .filter(Boolean))
      .slice(0, 12),
    latestCommands: commands.slice(-6).map(commandExperience),
  };
}

function validationState(summary) {
  if (summary.unresolvedFailedCommands > 0) return 'failed';
  if (summary.passedCommands > 0) return 'passed';
  return 'not-run';
}

function invalidatedPathExperience(summary, doNotRepeat) {
  const notes = doNotRepeat
    .filter((text) => !String(text).startsWith('Do not retry "'))
    .map((text) => ({
      kind: 'do-not-repeat-note',
      text,
    }));
  const repeated = summary.repeatedFailures.map((item) => ({
    kind: 'repeated-failure-signature',
    signature: item.signature,
    count: item.count,
    text: `Do not retry ${item.signature} without changing inputs; it failed ${item.count} times.`,
  }));
  return [...notes, ...repeated].slice(0, 16);
}

function commandExperience(entry) {
  return {
    id: entry.id,
    at: entry.at,
    command: entry.command,
    validationKey: entry.validationKey || commandValidationKey(entry.command),
    exitCode: entry.exitCode,
    timedOut: Boolean(entry.timedOut),
    durationMs: entry.durationMs,
    failureSignature: entry.failureSignature || null,
  };
}

function missingEvidenceExperience(evidencePack) {
  return (evidencePack?.missingEvidence || []).slice(0, 12).map((item) => ({
    id: item.id,
    severity: item.severity,
    reason: item.reason,
    commands: item.commands || [],
  }));
}

function suggestedNextEvidenceExperience(evidencePack) {
  return (evidencePack?.suggestedEvidenceToCollect || []).slice(0, 8).map((item) => ({
    id: item.id,
    reason: item.reason,
    commands: item.commands || [],
  }));
}

function semanticImpactExperience(evidencePack) {
  const semantic = evidencePack?.semanticProfile;
  if (!semantic) return { status: 'not-collected' };
  if (semantic.status !== 'enabled') {
    return {
      status: semantic.status || 'disabled',
      reason: semantic.reason || null,
    };
  }
  return {
    status: 'enabled',
    strategy: semantic.strategy,
    scan: semantic.scan ? {
      indexedFiles: semantic.scan.indexedFiles,
      maxFilesHit: Boolean(semantic.scan.maxFilesHit),
    } : null,
    impactSummary: semantic.impactSummary || null,
    topChangedModules: (semantic.changedModules || []).slice(0, 8).map((module) => ({
      path: module.path,
      role: module.role,
      indexed: Boolean(module.indexed),
      directDependents: module.directDependents || [],
      relatedTests: module.relatedTests || [],
      impactedEntrypoints: module.impactedEntrypoints || [],
      evidenceValue: module.evidenceValue || 0,
    })),
  };
}

function evidenceExperience(evidencePack, evidenceError) {
  if (evidencePack) {
    return {
      status: 'available',
      headline: evidencePack.changeSummary.headline,
      categories: evidencePack.changedFiles.summary.byCategory,
      riskSignals: evidencePack.riskSignals.map((item) => ({
        id: item.id,
        severity: item.severity,
        message: item.message,
      })),
      missingEvidence: (evidencePack.missingEvidence || []).map((item) => ({
        id: item.id,
        severity: item.severity,
        reason: item.reason,
        commands: item.commands || [],
      })),
      changedFiles: evidencePack.changedFiles.files.slice(0, 20).map((file) => ({
        status: file.status,
        path: file.path,
        category: file.category,
        additions: file.additions,
        deletions: file.deletions,
        untracked: Boolean(file.untracked),
      })),
    };
  }
  if (evidenceError) {
    return {
      status: 'unavailable',
      error: evidenceError,
    };
  }
  return {
    status: 'not-requested',
  };
}

function appendBriefCommand(lines, entry) {
  lines.push(`- ${compactText(entry.command, BRIEF_COMMAND_CHARS)}`);
  lines.push(`  - Exit: ${entry.exitCode}${entry.timedOut ? ' (timeout)' : ''}`);
  lines.push(`  - Signature: ${compactText(entry.failureSignature, BRIEF_TEXT_CHARS)}`);
  const preview = commandFailurePreview(entry);
  if (preview) lines.push(`  - Preview: ${preview}`);
}

function commandFailurePreview(entry) {
  const text = (entry.stderr || entry.stdout || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 2).join(' | ');
  return compactText(text, BRIEF_PREVIEW_CHARS);
}

function buildDoNotRepeat(ledger) {
  const scopedLedger = {
    ...ledger,
    entries: currentTaskEntries(ledger),
  };
  const summary = summarizeLedger(scopedLedger);
  const repeated = summary.repeatedFailures.map((item) => `Do not retry "${item.signature}" without changing inputs; it failed ${item.count} times.`);
  const tagged = scopedLedger.entries
    .filter((entry) => entry.kind === 'note' && entry.tags?.includes('do-not-repeat'))
    .map((entry) => entry.text);
  return dedupeStrings([...tagged, ...repeated]).slice(0, 12);
}

function currentTaskEntries(ledger) {
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  if (entries.length === 0) return [];

  if (ledger.activeTaskId) {
    const activeObjectiveIndex = entries.findIndex((entry) => (
      entry.kind === 'objective' && entry.taskId === ledger.activeTaskId
    ));
    if (activeObjectiveIndex !== -1) {
      return entries.slice(activeObjectiveIndex).filter((entry) => (
        !entry.taskId || entry.taskId === ledger.activeTaskId
      ));
    }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].kind === 'objective') return entries.slice(index);
  }
  return entries;
}

function compactText(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15)).trimEnd()}...[truncated]`;
}

function normalizeCommandName(command) {
  return String(command || '').trim().split(/\s+/).slice(0, 3).join(' ');
}

function normalizeFailureLine(line) {
  return String(line || '')
    .replace(/[A-Z]:\\[^:\s)]+/g, '<path>')
    .replace(/\/[^\s:)]+/g, '<path>')
    .replace(/:\d+:\d+/g, ':<line>:<col>')
    .replace(/:\d+/g, ':<line>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

function extractTags(text) {
  const tags = new Set();
  const value = String(text || '');
  const lower = value.toLowerCase();
  for (const match of value.matchAll(/#([A-Za-z][\w-]*)/g)) tags.add(match[1].toLowerCase());
  const chineseWarnings = [
    '\u4e0d\u8981\u91cd\u590d',
    '\u4e0d\u8981\u518d',
    '\u522b\u518d',
  ];
  if (/do not repeat|don't repeat/.test(lower) || chineseWarnings.some((item) => lower.includes(item))) {
    tags.add('do-not-repeat');
  }
  return [...tags];
}

function cleanText(text) {
  return redactText(String(text || '').trim());
}

function sanitizeCommandResult(result) {
  return {
    ...result,
    stdout: redactText(result.stdout || ''),
    stderr: redactText(result.stderr || ''),
  };
}

function countBy(items) {
  const result = {};
  for (const item of items) result[item] = (result[item] || 0) + 1;
  return result;
}

function formatCountMap(map) {
  return Object.entries(map || {}).map(([key, value]) => `${key}: ${value}`).join(', ');
}

function dedupeStrings(items) {
  const seen = new Set();
  return (items || []).filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function makeEntryId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

function summarizeValidationCommands(commands) {
  const latestPassByKey = new Map();
  const unresolvedFailures = [];
  const resolvedFailures = [];

  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const entry = commands[index];
    const key = entry.validationKey || commandValidationKey(entry.command);
    if (entry.exitCode === 0) {
      if (!latestPassByKey.has(key)) latestPassByKey.set(key, entry);
      continue;
    }
    const resolvedBy = latestPassByKey.get(key);
    if (resolvedBy) {
      resolvedFailures.push({ entry, resolvedBy });
    } else {
      unresolvedFailures.push(entry);
    }
  }

  return {
    unresolvedFailures: unresolvedFailures.reverse(),
    resolvedFailures: resolvedFailures.reverse(),
  };
}

function commandValidationKey(command) {
  return String(command || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
