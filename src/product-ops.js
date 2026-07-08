import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import {
  join,
  relative,
  resolve,
} from 'path';
import {
  collectEvidence,
  loadProjectConfig,
} from './evidence.js';
import {
  buildExperiencePacket,
  buildHandoffBrief,
  readLedger,
  resolveProjectDir,
  summarizeLedger,
  writeLedger,
} from './ledger.js';
import { redactObject, redactText } from './redact.js';

const DEFAULT_EXPORT_COMPACT = '8k';

export function runDoctor({ workdir = null } = {}) {
  const projectDir = resolveProjectDir(workdir);
  const checkedAt = new Date().toISOString();
  const checks = [];
  const configBundle = loadProjectConfig(projectDir);
  const ledger = readLedger(projectDir);
  const summary = summarizeLedger(ledger);

  addCheck(checks, configCheck(configBundle));
  addCheck(checks, ledgerCheck(ledger));
  addCheck(checks, objectiveCheck(summary));
  addCheck(checks, validationCheck(summary));
  addCheck(checks, aceIgnoreCheck(projectDir));
  addCheck(checks, runPolicyCheck(configBundle));
  addCheck(checks, retentionPolicyCheck(configBundle));
  addCheck(checks, gitEvidenceCheck(projectDir));
  addCheck(checks, packageScriptsCheck(projectDir));
  addCheck(checks, codexIntegrationCheck(projectDir));

  const errors = checks.filter((item) => item.status === 'fail').length;
  const warnings = checks.filter((item) => item.status === 'warn').length;

  return redactObject({
    schema: 'ace.doctor.v1',
    checkedAt,
    projectDir,
    summary: {
      status: errors > 0 ? 'fail' : (warnings > 0 ? 'warn' : 'pass'),
      errors,
      warnings,
      checks: checks.length,
    },
    currentTask: {
      objective: summary.objective,
      entries: summary.entries,
      commands: summary.commands,
      passedCommands: summary.passedCommands,
      failedCommands: summary.failedCommands,
      unresolvedFailedCommands: summary.unresolvedFailedCommands,
      latestFailure: summary.latestFailure ? {
        command: summary.latestFailure.command,
        failureSignature: summary.latestFailure.failureSignature,
      } : null,
    },
    checks,
  });
}

export function formatDoctorReport(report) {
  const lines = [];
  lines.push(`ACE Doctor: ${report.projectDir}`);
  lines.push(`Status: ${report.summary.status.toUpperCase()} (${report.summary.errors} errors, ${report.summary.warnings} warnings)`);
  lines.push(`Objective: ${report.currentTask.objective}`);
  lines.push('');
  for (const check of report.checks) {
    lines.push(`- ${check.status.toUpperCase()} ${check.id}: ${check.message}`);
  }
  return lines.join('\n');
}

export async function createExportBundle({
  workdir = null,
  out = null,
  noEvidence = false,
  semantic = false,
  compact = DEFAULT_EXPORT_COMPACT,
} = {}) {
  const projectDir = resolveProjectDir(workdir);
  const ledger = readLedger(projectDir);
  let evidencePack = null;
  let evidenceError = null;
  if (!noEvidence) {
    try {
      evidencePack = await collectEvidence({
        workdir: projectDir,
        noWrite: true,
        run: [],
        semantic,
      });
    } catch (error) {
      evidenceError = error.message;
    }
  }

  const generatedAt = new Date().toISOString();
  const outDir = out ? resolve(out) : join(projectDir, '.ace', 'exports', makeRunId(generatedAt));
  mkdirSync(outDir, { recursive: true });

  const packet = sanitizePortableValue(buildExperiencePacket({
    ledger,
    evidencePack,
    evidenceError,
  }), projectDir);
  const brief = sanitizePortableText(buildHandoffBrief({
    ledger,
    evidencePack,
    evidenceError,
    compactBudget: compact,
  }), projectDir);
  const doctor = sanitizePortableValue(runDoctor({ workdir: projectDir }), projectDir);
  const manifest = sanitizePortableValue({
    schema: 'ace.export.v1',
    generatedAt,
    sourceProject: '<project>',
    contents: {
      experience: 'experience.json',
      handoff: 'handoff.md',
      doctor: 'doctor.json',
      manifest: 'manifest.json',
    },
    policy: {
      scope: 'current-task',
      includesRawLedger: false,
      includesRawCommandOutput: false,
      evidenceRequested: !noEvidence,
      pathRedaction: '<project>',
      redaction: 'best-effort common secret redaction',
    },
    currentTask: {
      objective: packet.objective,
      status: packet.experienceSummary.status,
      validation: packet.validation.state,
    },
  }, projectDir);

  const files = {
    manifest: join(outDir, 'manifest.json'),
    experience: join(outDir, 'experience.json'),
    handoff: join(outDir, 'handoff.md'),
    doctor: join(outDir, 'doctor.json'),
  };
  writeFileSync(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(files.experience, `${JSON.stringify(packet, null, 2)}\n`);
  writeFileSync(files.handoff, brief);
  writeFileSync(files.doctor, `${JSON.stringify(doctor, null, 2)}\n`);

  return redactObject({
    schema: 'ace.export-result.v1',
    generatedAt,
    outDir,
    files,
    summary: manifest.currentTask,
  });
}

export function formatExportResult(result) {
  return [
    `ACE export: ${result.outDir}`,
    `Status: ${result.summary.status}; validation: ${result.summary.validation}`,
    `Files:`,
    `  - ${result.files.manifest}`,
    `  - ${result.files.experience}`,
    `  - ${result.files.handoff}`,
    `  - ${result.files.doctor}`,
  ].join('\n');
}

export function pruneAceArtifacts({
  workdir = null,
  apply = false,
  maxEntries = null,
  maxRuns = null,
  maxAgeDays = null,
} = {}) {
  const projectDir = resolveProjectDir(workdir);
  const configBundle = loadProjectConfig(projectDir);
  const retention = configBundle.config.retention || {};
  const policy = {
    maxEntries: positiveInteger(maxEntries) ?? retention.maxEntries,
    maxRuns: positiveInteger(maxRuns) ?? retention.maxRuns,
    maxAgeDays: positiveInteger(maxAgeDays) ?? retention.maxAgeDays,
  };
  const warnings = [];
  const hasPolicy = Boolean(policy.maxEntries || policy.maxRuns || policy.maxAgeDays);
  if (!hasPolicy) {
    warnings.push('No retention policy configured. Set retention in ace.config.json or pass --max-entries/--max-runs/--max-age-days.');
  }

  const ledger = readLedger(projectDir);
  const ledgerPlan = planLedgerPrune(ledger, policy);
  const runsPlan = planRunsPrune(projectDir, policy, warnings);

  if (apply && hasPolicy) {
    if (ledgerPlan.prunedEntries > 0) {
      writeLedger(projectDir, {
        ...ledger,
        entries: ledgerPlan.nextEntries,
      });
    }
    for (const item of runsPlan.pruned) {
      rmSync(item.path, { recursive: true, force: true });
    }
  }

  return redactObject({
    schema: 'ace.prune.v1',
    projectDir,
    generatedAt: new Date().toISOString(),
    applied: Boolean(apply && hasPolicy),
    policy,
    warnings,
    ledger: {
      beforeEntries: ledger.entries.length,
      afterEntries: apply && hasPolicy ? ledgerPlan.nextEntries.length : ledger.entries.length - ledgerPlan.prunedEntries,
      prunedEntries: hasPolicy ? ledgerPlan.prunedEntries : 0,
      preservedActiveEntries: ledgerPlan.preservedActiveEntries,
      dryRun: !(apply && hasPolicy),
    },
    runs: {
      beforeRuns: runsPlan.beforeRuns,
      afterRuns: apply && hasPolicy ? runsPlan.beforeRuns - runsPlan.pruned.length : runsPlan.beforeRuns - runsPlan.pruned.length,
      prunedRuns: hasPolicy ? runsPlan.pruned.length : 0,
      pruned: hasPolicy ? runsPlan.pruned.map((item) => ({
        name: item.name,
        reason: item.reason,
        mtime: item.mtime,
      })) : [],
      dryRun: !(apply && hasPolicy),
    },
  });
}

export function formatPruneResult(result) {
  const mode = result.applied ? 'APPLIED' : 'DRY RUN';
  const lines = [];
  lines.push(`ACE prune: ${mode}`);
  lines.push(`Project: ${result.projectDir}`);
  lines.push(`Policy: maxEntries=${result.policy.maxEntries ?? 'unset'}, maxRuns=${result.policy.maxRuns ?? 'unset'}, maxAgeDays=${result.policy.maxAgeDays ?? 'unset'}`);
  if (result.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  lines.push(`Ledger: ${result.ledger.prunedEntries} entries would be pruned; ${result.ledger.preservedActiveEntries} active entries preserved.`);
  lines.push(`Runs: ${result.runs.prunedRuns} run directories would be pruned.`);
  if (!result.applied) lines.push('Pass --apply to make these changes.');
  return lines.join('\n');
}

function configCheck(configBundle) {
  if (configBundle.source === 'parse-error') {
    return {
      id: 'config',
      status: 'fail',
      severity: 'error',
      message: configBundle.warnings[0] || 'ace.config.json could not be parsed.',
    };
  }
  if (configBundle.source === 'default') {
    return {
      id: 'config',
      status: 'warn',
      severity: 'warning',
      message: 'No ace.config.json found; defaults are usable, but policy and retention are not explicit.',
    };
  }
  return {
    id: 'config',
    status: 'pass',
    severity: 'info',
    message: `Loaded project config from ${configBundle.path}.`,
  };
}

function ledgerCheck(ledger) {
  if (ledger.warnings?.length) {
    return {
      id: 'ledger',
      status: 'warn',
      severity: 'warning',
      message: ledger.warnings.join(' '),
    };
  }
  return {
    id: 'ledger',
    status: 'pass',
    severity: 'info',
    message: `${ledger.entries.length} ledger entries available.`,
  };
}

function objectiveCheck(summary) {
  if (!summary.objective || summary.objective === 'Unspecified AI coding task.') {
    return {
      id: 'objective',
      status: 'warn',
      severity: 'warning',
      message: 'No active objective found. Run ace start "objective" before agent work.',
    };
  }
  return {
    id: 'objective',
    status: 'pass',
    severity: 'info',
    message: `Active objective: ${summary.objective}.`,
  };
}

function validationCheck(summary) {
  if (summary.unresolvedFailedCommands > 0) {
    return {
      id: 'validation',
      status: 'warn',
      severity: 'warning',
      message: `${summary.unresolvedFailedCommands} unresolved failed command(s) in the active task.`,
    };
  }
  if (summary.commands === 0) {
    return {
      id: 'validation',
      status: 'warn',
      severity: 'warning',
      message: 'No validation commands recorded for the active task.',
    };
  }
  return {
    id: 'validation',
    status: 'pass',
    severity: 'info',
    message: `${summary.passedCommands} passed command(s), ${summary.failedCommands} failed command(s).`,
  };
}

function aceIgnoreCheck(projectDir) {
  const gitignorePath = join(projectDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    return {
      id: 'local-artifacts',
      status: 'warn',
      severity: 'warning',
      message: '.gitignore is missing; .ace/ may be committed accidentally.',
    };
  }
  const gitignore = readText(gitignorePath);
  if (/(^|\r?\n)\.ace\/?(\r?\n|$)/.test(gitignore) || /(^|\r?\n)\.ace\/\*\*(\r?\n|$)/.test(gitignore)) {
    return {
      id: 'local-artifacts',
      status: 'pass',
      severity: 'info',
      message: '.ace/ is ignored by .gitignore.',
    };
  }
  return {
    id: 'local-artifacts',
    status: 'warn',
    severity: 'warning',
    message: '.gitignore does not ignore .ace/ local evidence artifacts.',
  };
}

function runPolicyCheck(configBundle) {
  const policy = configBundle.config.runPolicy || { allow: [], deny: [] };
  if (policy.allow.length > 0 || policy.deny.length > 0) {
    return {
      id: 'run-policy',
      status: 'pass',
      severity: 'info',
      message: `ace_run policy configured (${policy.allow.length} allow, ${policy.deny.length} deny).`,
    };
  }
  return {
    id: 'run-policy',
    status: 'warn',
    severity: 'warning',
    message: 'ace_run has no local allow/deny policy. Client approval is still required for MCP, but local policy is unset.',
  };
}

function retentionPolicyCheck(configBundle) {
  const retention = configBundle.config.retention || {};
  if (retention.maxEntries || retention.maxRuns || retention.maxAgeDays) {
    return {
      id: 'retention',
      status: 'pass',
      severity: 'info',
      message: `Retention configured (entries=${retention.maxEntries ?? 'unset'}, runs=${retention.maxRuns ?? 'unset'}, ageDays=${retention.maxAgeDays ?? 'unset'}).`,
    };
  }
  return {
    id: 'retention',
    status: 'warn',
    severity: 'warning',
    message: 'No retention policy configured for local ledgers and run artifacts.',
  };
}

function gitEvidenceCheck(projectDir) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: projectDir,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if ((result.status ?? 1) === 0) {
    return {
      id: 'git-evidence',
      status: 'pass',
      severity: 'info',
      message: `Git evidence available at ${result.stdout.trim()}.`,
    };
  }
  return {
    id: 'git-evidence',
    status: 'warn',
    severity: 'warning',
    message: 'Git diff evidence is unavailable here; ledger, command, and handoff features still work.',
  };
}

function packageScriptsCheck(projectDir) {
  const packagePath = join(projectDir, 'package.json');
  if (!existsSync(packagePath)) {
    return {
      id: 'validation-scripts',
      status: 'info',
      severity: 'info',
      message: 'No package.json found; doctor skipped JavaScript validation script checks.',
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf-8'));
    const scripts = parsed.scripts || {};
    const names = Object.keys(scripts);
    const validationNames = names.filter((name) => /(test|lint|typecheck|check|build)/i.test(name));
    if (validationNames.length === 0) {
      return {
        id: 'validation-scripts',
        status: 'warn',
        severity: 'warning',
        message: 'package.json has no obvious test/lint/typecheck/check/build scripts for validation evidence.',
      };
    }
    return {
      id: 'validation-scripts',
      status: 'pass',
      severity: 'info',
      message: `Validation scripts found: ${validationNames.slice(0, 8).join(', ')}.`,
    };
  } catch (error) {
    return {
      id: 'validation-scripts',
      status: 'fail',
      severity: 'error',
      message: `package.json could not be parsed: ${error.message}`,
    };
  }
}

function codexIntegrationCheck(projectDir) {
  const configPath = join(projectDir, '.codex', 'config.toml');
  const hooksPath = join(projectDir, '.codex', 'hooks.json');
  const hookPath = join(projectDir, '.codex', 'hooks', 'ace-stop-handoff.cjs');
  const hasAny = existsSync(configPath) || existsSync(hooksPath) || existsSync(hookPath);
  if (!hasAny) {
    return {
      id: 'codex-integration',
      status: 'info',
      severity: 'info',
      message: 'No project-local Codex integration detected. Run ace init --codex when Codex desktop integration is desired.',
    };
  }
  const problems = [];
  if (!existsSync(configPath) || !readText(configPath).includes('ace-mcp')) problems.push('missing ace-mcp config');
  if (!existsSync(hooksPath) || !readText(hooksPath).includes('ace-stop-handoff.cjs')) problems.push('missing Stop hook config');
  if (!existsSync(hookPath)) problems.push('missing generated Stop hook script');
  if (problems.length > 0) {
    return {
      id: 'codex-integration',
      status: 'warn',
      severity: 'warning',
      message: `Partial Codex integration detected: ${problems.join(', ')}.`,
    };
  }
  return {
    id: 'codex-integration',
    status: 'pass',
    severity: 'info',
    message: 'Project-local Codex MCP and Stop hook files are present.',
  };
}

function planLedgerPrune(ledger, policy) {
  const activeStart = activeTaskStartIndex(ledger);
  const historical = ledger.entries.slice(0, activeStart);
  const active = ledger.entries.slice(activeStart);
  const prunedIds = new Set();
  const cutoffMs = policy.maxAgeDays ? Date.now() - (policy.maxAgeDays * 24 * 60 * 60 * 1000) : null;

  let keptHistorical = historical.filter((entry) => {
    if (!cutoffMs) return true;
    const atMs = Date.parse(entry.at || entry.startedAt || '');
    if (!Number.isFinite(atMs) || atMs >= cutoffMs) return true;
    prunedIds.add(entry.id);
    return false;
  });

  if (policy.maxEntries && keptHistorical.length > policy.maxEntries) {
    const removeCount = keptHistorical.length - policy.maxEntries;
    for (const entry of keptHistorical.slice(0, removeCount)) prunedIds.add(entry.id);
    keptHistorical = keptHistorical.slice(removeCount);
  }

  return {
    nextEntries: [...keptHistorical, ...active],
    prunedEntries: prunedIds.size,
    preservedActiveEntries: active.length,
  };
}

function planRunsPrune(projectDir, policy, warnings) {
  const runsDir = join(projectDir, '.ace', 'runs');
  if (!existsSync(runsDir)) {
    return {
      beforeRuns: 0,
      pruned: [],
    };
  }
  const root = resolve(runsDir);
  const entries = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = resolve(runsDir, entry.name);
      if (!isInside(path, root)) {
        warnings.push(`Skipped suspicious run path outside .ace/runs: ${entry.name}`);
        return null;
      }
      const stat = statSync(path);
      return {
        name: entry.name,
        path,
        mtimeMs: stat.mtimeMs,
        mtime: stat.mtime.toISOString(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const pruned = [];
  const seen = new Set();
  const cutoffMs = policy.maxAgeDays ? Date.now() - (policy.maxAgeDays * 24 * 60 * 60 * 1000) : null;

  if (policy.maxRuns && entries.length > policy.maxRuns) {
    for (const item of entries.slice(policy.maxRuns)) {
      seen.add(item.path);
      pruned.push({ ...item, reason: `exceeds maxRuns ${policy.maxRuns}` });
    }
  }
  if (cutoffMs) {
    for (const item of entries) {
      if (item.mtimeMs >= cutoffMs || seen.has(item.path)) continue;
      seen.add(item.path);
      pruned.push({ ...item, reason: `older than maxAgeDays ${policy.maxAgeDays}` });
    }
  }

  return {
    beforeRuns: entries.length,
    pruned,
  };
}

function activeTaskStartIndex(ledger) {
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  if (entries.length === 0) return 0;
  if (ledger.activeTaskId) {
    const index = entries.findIndex((entry) => (
      entry.kind === 'objective' && entry.taskId === ledger.activeTaskId
    ));
    if (index >= 0) return index;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].kind === 'objective') return index;
  }
  return 0;
}

function addCheck(checks, check) {
  checks.push(sanitizePortableValue(check, ''));
}

function sanitizePortableValue(value, projectDir) {
  const redacted = redactObject(value);
  if (typeof redacted === 'string') return sanitizePortableText(redacted, projectDir);
  if (Array.isArray(redacted)) return redacted.map((item) => sanitizePortableValue(item, projectDir));
  if (!redacted || typeof redacted !== 'object') return redacted;
  return Object.fromEntries(
    Object.entries(redacted).map(([key, item]) => [key, sanitizePortableValue(item, projectDir)]),
  );
}

function sanitizePortableText(text, projectDir) {
  let value = redactText(text);
  for (const variant of pathVariants(projectDir)) {
    value = value.replace(new RegExp(escapeRegExp(variant), 'gi'), '<project>');
  }
  return value;
}

function pathVariants(projectDir) {
  if (!projectDir) return [];
  const resolved = resolve(projectDir);
  return [
    resolved,
    resolved.replace(/\\/g, '/'),
  ];
}

function readText(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function isInside(path, root) {
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') && !resolve(rel).startsWith('..');
}

function positiveInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeRunId(date = new Date().toISOString()) {
  return date.replace(/[:.]/g, '-');
}
