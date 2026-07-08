#!/usr/bin/env node
import {
  collectEvidence,
  formatEvidenceSummary,
} from './evidence.js';
import {
  formatInitSummary,
  initProject,
} from './init.js';
import {
  appendNote,
  buildExperiencePacket,
  buildHandoffBrief,
  formatStatus,
  readLedger,
  recordCommand,
  resolveProjectDir,
  startLedger,
  writeHandoffBrief,
} from './ledger.js';
import {
  createExportBundle,
  formatExportResult,
  formatDoctorReport,
  formatPruneResult,
  pruneAceArtifacts,
  runDoctor,
} from './product-ops.js';

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('-') ? args[0] : 'status';
const flags = parseFlags(args[0] === command ? args.slice(1) : args);

async function main() {
  switch (command) {
    case 'init':
      await cmdInit(flags);
      break;
    case 'start':
      await cmdStart(flags);
      break;
    case 'note':
      await cmdNote(flags);
      break;
    case 'run':
      await cmdRun(flags);
      break;
    case 'status':
      await cmdStatus(flags);
      break;
    case 'experience':
      await cmdExperience(flags);
      break;
    case 'context':
      await cmdExperience(flags);
      break;
    case 'brief':
      await cmdBrief(flags);
      break;
    case 'collect':
      await cmdCollect(flags);
      break;
    case 'doctor':
      await cmdDoctor(flags);
      break;
    case 'export':
      await cmdExport(flags);
      break;
    case 'prune':
      await cmdPrune(flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

async function cmdInit(flags) {
  if (flags.help) {
    printHelp();
    return;
  }

  const result = initProject({
    workdir: flags.workdir,
    force: Boolean(flags.force),
    codex: Boolean(flags.codex),
  });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatInitSummary(result));
  }
}

async function cmdStart(flags) {
  if (flags.help) {
    printHelp();
    return;
  }

  const objective = flags._.join(' ').trim();
  if (!objective) {
    console.error('ace start failed: provide an objective, for example ace start "fix export flow"');
    process.exitCode = 1;
    return;
  }

  const { ledger, path } = startLedger({
    workdir: flags.workdir,
    objective,
    reset: Boolean(flags.reset),
  });
  console.log(`ACE objective: ${ledger.objective}`);
  console.log(`Ledger: ${path}`);
}

async function cmdNote(flags) {
  if (flags.help) {
    printHelp();
    return;
  }

  const text = flags._.join(' ').trim();
  if (!text) {
    console.error('ace note failed: provide a note');
    process.exitCode = 1;
    return;
  }

  const { entry, path } = appendNote({
    workdir: flags.workdir,
    text,
  });
  console.log(`ACE note recorded: ${entry.id}`);
  console.log(`Ledger: ${path}`);
}

async function cmdRun(flags) {
  if (flags.help) {
    printHelp();
    return;
  }

  const runCommand = flags._.join(' ').trim();
  if (!runCommand) {
    console.error('ace run failed: provide a command, for example ace run "npm test"');
    process.exitCode = 1;
    return;
  }

  try {
    const { entry, path } = await recordCommand({
      workdir: flags.workdir,
      command: runCommand,
      timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
      maxOutputBytes: flags.maxOutputBytes ? Number(flags.maxOutputBytes) : undefined,
    });
    const status = entry.exitCode === 0 ? 'PASS' : 'FAIL';
    console.log(`${status} ${entry.command} (${entry.durationMs}ms)`);
    if (entry.failureSignature) console.log(`Failure signature: ${entry.failureSignature}`);
    console.log(`Ledger: ${path}`);
    process.exitCode = entry.exitCode;
  } catch (error) {
    console.error(`ace run failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function cmdStatus(flags) {
  if (flags.help) {
    printHelp();
    return;
  }

  const projectDir = resolveProjectDir(flags.workdir);
  const ledger = readLedger(projectDir);
  console.log(formatStatus(ledger));
}

async function cmdExperience(flags) {
  if (flags.help) {
    printHelp();
    return;
  }

  const projectDir = resolveProjectDir(flags.workdir);
  const ledger = readLedger(projectDir);
  let evidencePack = null;
  let evidenceError = null;
  if (!flags.noEvidence) {
    try {
      evidencePack = await collectEvidence({
        ...flags,
        workdir: projectDir,
        noWrite: true,
        run: [],
      });
    } catch (error) {
      evidenceError = error.message;
    }
  }

  const packet = buildExperiencePacket({
    ledger,
    evidencePack,
    evidenceError,
  });
  console.log(JSON.stringify(packet, null, 2));
}

async function cmdBrief(flags) {
  if (flags.help) {
    printHelp();
    return;
  }

  const projectDir = resolveProjectDir(flags.workdir);
  const ledger = readLedger(projectDir);
  let evidencePack = null;
  let evidenceError = null;
  if (!flags.noEvidence) {
    try {
      evidencePack = await collectEvidence({
        ...flags,
        workdir: projectDir,
        noWrite: true,
        run: [],
      });
    } catch (error) {
      evidenceError = error.message;
    }
  }

  const brief = buildHandoffBrief({
    ledger,
    evidencePack,
    evidenceError,
    compactBudget: flags.compact || null,
  });

  if (flags.print) {
    console.log(brief);
    return;
  }

  const outPath = writeHandoffBrief(projectDir, brief, flags.out);
  console.log(`Handoff brief: ${outPath}`);
}

async function cmdCollect(flags) {
  if (flags.help) {
    printHelp();
    return;
  }

  try {
    const pack = await collectEvidence(flags);
    if (flags.json) {
      console.log(JSON.stringify(pack, null, 2));
    } else if (flags.prompt) {
      console.log(pack.recommendedPrompt);
    } else {
      console.log(formatEvidenceSummary(pack));
    }
  } catch (error) {
    console.error(`ace collect failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function cmdDoctor(flags) {
  if (flags.help) {
    printHelp();
    return;
  }

  try {
    const report = runDoctor({ workdir: flags.workdir });
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctorReport(report));
    }
    if (report.summary.status === 'fail') process.exitCode = 1;
  } catch (error) {
    console.error(`ace doctor failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function cmdExport(flags) {
  if (flags.help) {
    printHelp();
    return;
  }

  try {
    const result = await createExportBundle({
      workdir: flags.workdir,
      out: flags.out || null,
      noEvidence: Boolean(flags.noEvidence),
      semantic: Boolean(flags.semantic),
      compact: flags.compact || null,
    });
    console.log(formatExportResult(result));
  } catch (error) {
    console.error(`ace export failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function cmdPrune(flags) {
  if (flags.help) {
    printHelp();
    return;
  }

  try {
    const result = pruneAceArtifacts({
      workdir: flags.workdir,
      apply: Boolean(flags.apply),
      maxEntries: flags.maxEntries || null,
      maxRuns: flags.maxRuns || null,
      maxAgeDays: flags.maxAgeDays || null,
    });
    console.log(formatPruneResult(result));
  } catch (error) {
    console.error(`ace prune failed: ${error.message}`);
    process.exitCode = 1;
  }
}

function parseFlags(items) {
  const flags = { run: [], ignore: [], _: [] };
  for (let i = 0; i < items.length; i++) {
    const arg = items[i];
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--prompt') flags.prompt = true;
    else if (arg === '--staged') flags.staged = true;
    else if (arg === '--no-untracked') flags.noUntracked = true;
    else if (arg === '--no-write') flags.noWrite = true;
    else if (arg === '--no-evidence') flags.noEvidence = true;
    else if (arg === '--no-config') flags.noConfig = true;
    else if (arg === '--reset') flags.reset = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--codex') flags.codex = true;
    else if (arg === '--print') flags.print = true;
    else if (arg === '--semantic') flags.semantic = true;
    else if (arg === '--no-semantic') flags.noSemantic = true;
    else if (arg === '--apply') flags.apply = true;
    else if (arg === '--config' && items[i + 1]) flags.config = items[++i];
    else if (arg === '--ignore' && items[i + 1]) flags.ignore.push(items[++i]);
    else if (arg === '--workdir' && items[i + 1]) flags.workdir = items[++i];
    else if (arg === '--out' && items[i + 1]) flags.out = items[++i];
    else if (arg === '--since' && items[i + 1]) flags.since = items[++i];
    else if ((arg === '--run' || arg === '--command') && items[i + 1]) flags.run.push(items[++i]);
    else if (arg === '--compact') flags.compact = items[i + 1] && !items[i + 1].startsWith('-') ? items[++i] : true;
    else if (arg === '--timeout' && items[i + 1]) flags.timeout = items[++i];
    else if (arg === '--max-output-bytes' && items[i + 1]) flags.maxOutputBytes = items[++i];
    else if (arg === '--max-diff-bytes' && items[i + 1]) flags.maxDiffBytes = items[++i];
    else if (arg === '--max-pack-bytes' && items[i + 1]) flags.maxPackBytes = items[++i];
    else if (arg === '--max-files' && items[i + 1]) flags.maxFiles = items[++i];
    else if (arg === '--max-semantic-files' && items[i + 1]) flags.maxSemanticFiles = items[++i];
    else if (arg === '--max-semantic-file-bytes' && items[i + 1]) flags.maxSemanticFileBytes = items[++i];
    else if (arg === '--max-entries' && items[i + 1]) flags.maxEntries = items[++i];
    else if (arg === '--max-runs' && items[i + 1]) flags.maxRuns = items[++i];
    else if (arg === '--max-age-days' && items[i + 1]) flags.maxAgeDays = items[++i];
    else flags._.push(arg);
  }
  return flags;
}

function printHelp() {
  console.log([
    'ace - engineering experience handoff for AI coding agents',
    '',
    'Usage:',
    '  ace init [--force] [--codex]',
    '  ace start "objective" [--reset]',
    '  ace note "what was tried / what not to repeat"',
    '  ace run "npm test"',
    '  ace status',
    '  ace experience [--json] [--no-evidence]',
    '  ace brief [--compact 8k] [--print]',
    '  ace collect [options]',
    '  ace doctor [--json]',
    '  ace export [--compact 8k] [--out <dir>] [--semantic] [--no-evidence]',
    '  ace prune [--apply] [--max-entries <n>] [--max-runs <n>] [--max-age-days <n>]',
    '',
    'Common options:',
    '  --workdir <dir>          Project directory to inspect',
    '  --timeout <seconds>      Command/git timeout',
    '  --max-output-bytes <n>   Command output byte cap per stream',
    '',
    'Ledger options:',
    '  --force                  Overwrite files generated by ace init',
    '  --codex                  Also generate project-local Codex MCP and hook config',
    '  --reset                  Clear prior local ledger entries before starting this objective',
    '  --no-evidence            Build handoff brief without current git evidence',
    '  --print                  Print handoff brief instead of writing .ace/handoff.md',
    '',
    'Collect options:',
    '  --out <dir>              Output directory for evidence.json/evidence.md/prompt.md',
    '  --staged                 Inspect staged changes only',
    '  --since <ref>            Inspect branch changes since a base ref',
    '  --no-untracked           Exclude untracked files in working-tree mode',
    '  --config <file>          Use a specific ace.config.json file',
    '  --no-config              Disable project config loading',
    '  --ignore <pattern>       Add an ignore pattern for this run; repeatable',
    '  --run <cmd>              Run a command and capture output; repeatable',
    '  --compact <budget>       Token-budget prompt.md, e.g. 8k or 20000',
    '  --semantic               Include optional bounded semantic evidence in collect',
    '  --json                   Print the evidence JSON',
    '  --prompt                 Print only the AI review prompt',
    '  --no-write               Do not write artifacts',
    '  --max-diff-bytes <n>     Diff snippet byte cap per file',
    '  --max-pack-bytes <n>     Total text budget for evidence.json expandable fields',
    '',
    'Examples:',
    '  ace init',
    '  ace experience --json',
    '  ace start "replace export flow without breaking renderer"',
    '  ace run "npm test"',
    '  ace note "Do not repeat wasm path rewrite; it broke package exports"',
    '  ace brief --compact 8k',
    '  ace collect --compact 8k --prompt',
    '  ace doctor',
    '  ace export --compact 8k --out ./handoff',
    '  ace prune --max-age-days 30 --apply',
    '',
    'Positioning:',
    '  ACE is not a CodeGraph clone or a generic memory layer. It compiles',
    '  attempts, failures, validation output, semantic/risk evidence, and',
    '  do-not-repeat notes into portable engineering experience packets.',
    '  ace start opens a new active task boundary while preserving older',
    '  ledger history unless --reset is used.',
    '',
    'Compatibility:',
    '  ace context is kept as an alias for ace experience.',
  ].join('\n'));
}

main();
