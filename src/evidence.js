import { spawn } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { redactObject, redactText } from './redact.js';

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_OUTPUT_BYTES = 12000;
const DEFAULT_DIFF_BYTES = 60000;
const DEFAULT_MAX_FILES = 120;
const DEFAULT_PACK_BYTES = 2000000;
const DEFAULT_DIFF_TOTAL_RATIO = 0.75;
const DEFAULT_SEMANTIC_MAX_FILES = 1500;
const DEFAULT_SEMANTIC_MAX_FILE_BYTES = 200000;
const DEFAULT_SEMANTIC_MAX_DEPENDENTS = 12;
const DEFAULT_SEMANTIC_MAX_RELATED_TESTS = 12;
const DEFAULT_PROMPT_FILE_LIMIT = 80;
const DEFAULT_PROMPT_DIFF_LIMIT = 40;
const DEFAULT_PROMPT_DIFF_CHARS = 4000;
const DEFAULT_PROMPT_COMMAND_CHARS = 1200;
const DEFAULT_COMPACT_BUDGET_TOKENS = 8000;
const DEFAULT_IGNORE = [
  '.git/**',
  '.ace/**',
  '.nle/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'out/**',
  'coverage/**',
  '.next/**',
  '.turbo/**',
  '.cache/**',
  '*.log',
];

export async function collectEvidence(flags = {}) {
  const baseOptions = normalizeOptions(flags);
  const startedAt = new Date().toISOString();
  const projectDir = resolve(baseOptions.workdir || process.cwd());
  const configBundle = loadProjectConfig(projectDir, baseOptions.configPath, baseOptions.noConfig);
  const options = finalizeOptions(baseOptions, configBundle);
  const repoRoot = await gitOutput(projectDir, ['rev-parse', '--show-toplevel'], options);
  const scopePath = toGitPath(relative(repoRoot, projectDir)) || '.';
  const mode = collectionMode(options);
  const changedFiles = await collectChangedFiles({ repoRoot, projectDir, scopePath, options });
  const packageProfile = readPackageProfile(projectDir);
  const semanticProfile = buildSemanticProfile({
    projectDir,
    changedFiles,
    packageProfile,
    options,
  });
  const diffResult = await collectDiffSnippets({
    repoRoot,
    projectDir,
    scopePath,
    changedFiles,
    options,
  });
  const diffSnippets = diffResult.snippets;
  const availableCommands = buildAvailableCommands(packageProfile, options.projectConfig);
  const suggestedEvidence = buildSuggestedEvidence({
    changedFiles,
    packageProfile,
    availableCommands,
  });
  const commandResult = applyCommandOutputBudget(
    await runRequestedCommands(projectDir, options),
    options.maxCommandOutputTotalBytes,
  );
  const executedCommands = commandResult.commands;
  const riskSignals = buildRiskSignals({
    changedFiles,
    executedCommands,
  });
  const missingEvidence = buildMissingEvidence({
    changedFiles,
    suggestedEvidence,
    executedCommands,
    riskSignals,
  });
  const openQuestions = buildOpenQuestions({ changedFiles, riskSignals });
  const finishedAt = new Date().toISOString();

  const pack = redactObject({
    schema: 'ace.evidence.v1',
    tool: {
      name: 'ai-change-evidence',
      version: '0.1.0',
      role: 'evidence-layer',
    },
    intent: {
      productPositioning: 'Compile reliable local change evidence as support for AI coding experience handoff.',
      nonGoal: 'Do not pretend rule heuristics can replace AI judgment.',
    },
    collection: {
      mode,
      startedAt,
      finishedAt,
      projectDir,
      repoRoot,
      scopePath,
      since: options.since || null,
      staged: options.staged,
      includedUntracked: options.includeUntracked,
      limits: {
        maxFiles: options.maxFiles,
        maxDiffBytes: options.maxDiffBytes,
        maxOutputBytes: options.maxOutputBytes,
        maxPackBytes: options.maxPackBytes,
      },
    },
    config: {
      source: options.configSource,
      path: options.configPathLoaded,
      warnings: options.configWarnings,
      ignorePatterns: options.ignorePatterns,
      preferredCommands: options.projectConfig.preferredCommands,
      runPolicy: {
        allowCount: options.projectConfig.runPolicy.allow.length,
        denyCount: options.projectConfig.runPolicy.deny.length,
      },
      prompt: options.projectConfig.prompt,
      semantic: options.projectConfig.semantic,
    },
    changeSummary: summarizeChange(changedFiles),
    packageProfile,
    semanticProfile,
    changedFiles,
    diffSnippets,
    availableCommands,
    suggestedEvidenceToCollect: suggestedEvidence,
    executedCommands,
    riskSignals,
    missingEvidence,
    openQuestionsForAI: openQuestions,
    evidenceBudget: {
      policy: 'Control expandable evidence text before writing evidence.json; prompt.md may apply a separate token budget.',
      limits: {
        maxPackBytes: options.maxPackBytes,
        maxDiffTextBytes: options.maxDiffTextBytes,
        maxCommandOutputTotalBytes: options.maxCommandOutputTotalBytes,
      },
      diffSnippets: diffResult.budget,
      commandOutputs: commandResult.budget,
      estimatedJsonBytes: null,
    },
  });
  pack.recommendedPrompt = buildRecommendedPrompt(pack, {
    compactBudget: options.compactBudget,
  });
  pack.evidenceBudget.estimatedJsonBytes = Buffer.byteLength(JSON.stringify(pack), 'utf-8');

  if (!options.noWrite) {
    const outDir = options.out
      ? resolve(options.out)
      : join(projectDir, '.ace', 'runs', makeRunId());
    writeEvidencePack(pack, outDir);
  }

  return pack;
}

export function writeEvidencePack(pack, outDir) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'evidence.json');
  const markdownPath = join(outDir, 'evidence.md');
  const promptPath = join(outDir, 'prompt.md');
  const safePack = redactObject(pack);
  safePack.paths = {
    outDir,
    json: jsonPath,
    markdown: markdownPath,
    prompt: promptPath,
  };
  safePack.recommendedPrompt = buildRecommendedPrompt(safePack);
  writeFileSync(jsonPath, JSON.stringify(safePack, null, 2));
  writeFileSync(markdownPath, formatEvidenceMarkdown(safePack));
  writeFileSync(promptPath, safePack.recommendedPrompt);
  pack.paths = safePack.paths;
  writeFileSync(jsonPath, JSON.stringify(safePack, null, 2));
  return pack.paths;
}

export function formatEvidenceSummary(pack) {
  const lines = [];
  lines.push(`ACE Evidence: ${pack.collection.projectDir}`);
  lines.push(`Mode: ${pack.collection.mode}`);
  lines.push(`Files: ${pack.changedFiles.summary.total} (+${pack.changedFiles.summary.additions}/-${pack.changedFiles.summary.deletions})`);
  lines.push(`Categories: ${formatCountMap(pack.changedFiles.summary.byCategory) || 'none'}`);
  if (pack.riskSignals.length > 0) {
    lines.push(`Signals: ${pack.riskSignals.map((item) => item.id).join(', ')}`);
  }
  if (pack.missingEvidence?.length > 0) {
    lines.push(`Missing evidence: ${pack.missingEvidence.map((item) => item.id).slice(0, 8).join(', ')}`);
  }
  if (pack.semanticProfile?.status === 'enabled') {
    lines.push(`Semantic index: ${pack.semanticProfile.scan.indexedFiles} files, ${pack.semanticProfile.changedModules.length} changed modules`);
  }
  if (pack.evidenceBudget) {
    lines.push(`Evidence text budget: diff ${pack.evidenceBudget.diffSnippets.textBytes}/${pack.evidenceBudget.limits.maxDiffTextBytes} bytes, commands ${pack.evidenceBudget.commandOutputs.textBytes}/${pack.evidenceBudget.limits.maxCommandOutputTotalBytes} bytes`);
  }
  if (pack.executedCommands.length > 0) {
    lines.push('Commands:');
    for (const command of pack.executedCommands.slice(0, 8)) {
      const status = command.exitCode === 0 ? 'PASS' : 'FAIL';
      lines.push(`  - ${status} ${command.command} (${command.durationMs}ms)`);
    }
  }
  if (pack.paths) {
    lines.push(`Evidence: ${pack.paths.json}`);
    lines.push(`Prompt: ${pack.paths.prompt}`);
  }
  return lines.join('\n');
}

export function normalizeOptions(flags = {}) {
  return {
    workdir: flags.workdir || null,
    out: flags.out || null,
    staged: Boolean(flags.staged),
    since: flags.since || null,
    includeUntracked: !flags.noUntracked && !flags.staged && !flags.since,
    runs: Array.isArray(flags.run) ? flags.run : [],
    timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : null,
    maxOutputBytes: flags.maxOutputBytes ? Number(flags.maxOutputBytes) : null,
    maxDiffBytes: flags.maxDiffBytes ? Number(flags.maxDiffBytes) : null,
    maxFiles: flags.maxFiles ? Number(flags.maxFiles) : null,
    maxPackBytes: flags.maxPackBytes ? Number(flags.maxPackBytes) : null,
    semanticEnabled: Boolean(flags.semantic) && !flags.noSemantic,
    noSemantic: Boolean(flags.noSemantic),
    maxSemanticFiles: flags.maxSemanticFiles ? Number(flags.maxSemanticFiles) : null,
    maxSemanticFileBytes: flags.maxSemanticFileBytes ? Number(flags.maxSemanticFileBytes) : null,
    compactBudget: parseCompactBudget(flags.compact),
    configPath: flags.config || null,
    noConfig: Boolean(flags.noConfig),
    ignorePatterns: Array.isArray(flags.ignore) ? flags.ignore : [],
    noWrite: Boolean(flags.noWrite),
  };
}

export function loadProjectConfig(projectDir, explicitPath = null, noConfig = false) {
  if (noConfig) {
    return {
      source: 'disabled',
      path: null,
      config: normalizeProjectConfig({}),
      warnings: [],
    };
  }

  const configPath = explicitPath ? resolve(explicitPath) : join(projectDir, 'ace.config.json');
  if (!existsSync(configPath)) {
    return {
      source: explicitPath ? 'missing-explicit' : 'default',
      path: explicitPath ? configPath : null,
      config: normalizeProjectConfig({}),
      warnings: explicitPath ? [`Config file not found: ${configPath}`] : [],
    };
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    return {
      source: 'file',
      path: configPath,
      config: normalizeProjectConfig(raw),
      warnings: [],
    };
  } catch (error) {
    return {
      source: 'parse-error',
      path: configPath,
      config: normalizeProjectConfig({}),
      warnings: [`Could not parse config: ${error.message}`],
    };
  }
}

export function normalizeProjectConfig(raw = {}) {
  const limits = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  const prompt = raw.prompt && typeof raw.prompt === 'object' ? raw.prompt : {};
  const semantic = raw.semantic && typeof raw.semantic === 'object' ? raw.semantic : {};
  const runPolicy = raw.runPolicy && typeof raw.runPolicy === 'object' ? raw.runPolicy : {};
  const compactBudget = prompt.compactBudget ?? prompt.compact ?? null;
  return {
    ignore: arrayOfStrings(raw.ignore),
    preferredCommands: normalizePreferredCommands(raw.preferredCommands),
    runPolicy: {
      allow: arrayOfStrings(runPolicy.allow),
      deny: arrayOfStrings(runPolicy.deny),
    },
    prompt: {
      profile: typeof prompt.profile === 'string' ? prompt.profile : 'ai-coding-handoff',
      instructions: arrayOfStrings(prompt.instructions),
      responseFormat: arrayOfStrings(prompt.responseFormat),
      compactBudget: parseCompactBudget(compactBudget),
    },
    semantic: {
      enabled: Boolean(semantic.enabled),
    },
    limits: {
      maxFiles: positiveNumber(limits.maxFiles),
      maxDiffBytes: positiveNumber(limits.maxDiffBytes),
      maxOutputBytes: positiveNumber(limits.maxOutputBytes),
      maxPackBytes: positiveNumber(limits.maxPackBytes),
      maxSemanticFiles: positiveNumber(limits.maxSemanticFiles),
      maxSemanticFileBytes: positiveNumber(limits.maxSemanticFileBytes),
      timeoutSeconds: positiveNumber(limits.timeoutSeconds),
    },
  };
}

function finalizeOptions(baseOptions, configBundle) {
  const config = configBundle.config;
  const limit = config.limits;
  return {
    ...baseOptions,
    timeoutMs: baseOptions.timeoutMs || (limit.timeoutSeconds ? limit.timeoutSeconds * 1000 : DEFAULT_TIMEOUT_MS),
    maxOutputBytes: baseOptions.maxOutputBytes || limit.maxOutputBytes || DEFAULT_OUTPUT_BYTES,
    maxDiffBytes: baseOptions.maxDiffBytes || limit.maxDiffBytes || DEFAULT_DIFF_BYTES,
    maxFiles: baseOptions.maxFiles || limit.maxFiles || DEFAULT_MAX_FILES,
    maxPackBytes: baseOptions.maxPackBytes || limit.maxPackBytes || DEFAULT_PACK_BYTES,
    maxDiffTextBytes: Math.floor((baseOptions.maxPackBytes || limit.maxPackBytes || DEFAULT_PACK_BYTES) * DEFAULT_DIFF_TOTAL_RATIO),
    maxCommandOutputTotalBytes: (baseOptions.maxPackBytes || limit.maxPackBytes || DEFAULT_PACK_BYTES)
      - Math.floor((baseOptions.maxPackBytes || limit.maxPackBytes || DEFAULT_PACK_BYTES) * DEFAULT_DIFF_TOTAL_RATIO),
    semanticEnabled: !baseOptions.noSemantic && (baseOptions.semanticEnabled || Boolean(config.semantic.enabled)),
    maxSemanticFiles: baseOptions.maxSemanticFiles || limit.maxSemanticFiles || DEFAULT_SEMANTIC_MAX_FILES,
    maxSemanticFileBytes: baseOptions.maxSemanticFileBytes || limit.maxSemanticFileBytes || DEFAULT_SEMANTIC_MAX_FILE_BYTES,
    compactBudget: baseOptions.compactBudget || config.prompt.compactBudget || null,
    ignorePatterns: dedupeStrings([
      ...DEFAULT_IGNORE,
      ...config.ignore,
      ...baseOptions.ignorePatterns,
    ]),
    projectConfig: config,
    configSource: configBundle.source,
    configPathLoaded: configBundle.path,
    configWarnings: configBundle.warnings,
  };
}

export function categorizeFile(path) {
  const lower = String(path || '').toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(lower) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) return 'test';
  if (/^\.github\/workflows\/|(^|\/)(circleci|\.circleci|\.gitlab-ci|azure-pipelines|jenkinsfile)/.test(lower)) return 'ci';
  if (/(^|\/)(scripts?|tools?)\/.*(ci|deploy|oidc|publish|release|workflow).*\.[cm]?[jt]s$/.test(lower)) return 'ci';
  if (/(\.mdx?$|docs\/|readme|changelog|license)/.test(lower)) return 'docs';
  if (isConfigPath(lower)) return 'config';
  if (/\.(css|scss|sass|less|svg|png|jpg|jpeg|gif|webp|glsl|frag|vert)$/.test(lower)) return 'visual';
  if (/\.(jsx?|tsx?|mjs|cjs|py|go|rs|java|cs|cpp|c|h|hpp)$/.test(lower)) return 'source';
  if (/\.(json|yaml|yml|toml|xml|csv)$/.test(lower)) return 'data';
  return 'other';
}

export function summarizeChange(changedFiles) {
  const categories = changedFiles.summary.byCategory;
  const traits = [];
  if (categories.source && categories.test) traits.push('source-with-tests');
  if (categories.source && !categories.test) traits.push('source-without-tests');
  if (categories.ci) traits.push('ci-or-release');
  if (categories.config) traits.push('config-or-dependency');
  if (categories.docs && Object.keys(categories).length === 1) traits.push('docs-only');
  if (categories.visual) traits.push('visual-surface');
  if (changedFiles.summary.total > 40) traits.push('large-change');

  return {
    totalFiles: changedFiles.summary.total,
    additions: changedFiles.summary.additions,
    deletions: changedFiles.summary.deletions,
    categories,
    traits,
    headline: buildChangeHeadline(changedFiles.summary.total, categories, traits),
  };
}

export function buildSemanticProfile({ projectDir, changedFiles, packageProfile, options }) {
  if (!options?.semanticEnabled) {
    return {
      status: 'disabled',
      strategy: 'bounded-static-semantic-index',
      reason: 'Disabled by --no-semantic.',
    };
  }

  const scan = scanSemanticFiles(projectDir, options);
  const records = scan.files.map((file) => parseSemanticFile(file));
  const indexedPaths = new Set(records.map((record) => record.path));
  const byPath = new Map(records.map((record) => [record.path, record]));

  for (const record of records) {
    const resolved = resolveModuleImports(record, indexedPaths);
    record.imports = resolved.imports;
    record.unresolvedLocalImports = resolved.unresolvedLocalImports;
  }

  const reverseImports = buildReverseImports(records);
  const entrypoints = detectEntrypoints(packageProfile, records, indexedPaths);
  const entrypointSet = new Set(entrypoints.map((item) => item.path));
  const changedModules = buildChangedSemanticModules({
    changedFiles,
    byPath,
    reverseImports,
    entrypointSet,
    records,
  });

  return {
    status: 'enabled',
    strategy: 'bounded-static-semantic-index',
    purpose: 'Provide project-aware facts for AI review without building a full AST or language-server index.',
    limits: {
      maxIndexedFiles: options.maxSemanticFiles,
      maxFileBytes: options.maxSemanticFileBytes,
      maxDependentsPerChangedFile: DEFAULT_SEMANTIC_MAX_DEPENDENTS,
      maxRelatedTestsPerChangedFile: DEFAULT_SEMANTIC_MAX_RELATED_TESTS,
    },
    scan: {
      indexedFiles: records.length,
      skippedIgnored: scan.skippedIgnored,
      skippedUnsupported: scan.skippedUnsupported,
      skippedLarge: scan.skippedLarge,
      maxFilesHit: scan.maxFilesHit,
      byCategory: countBy(records, 'category'),
    },
    entrypoints,
    impactSummary: summarizeSemanticImpact(changedModules),
    changedModules,
  };
}

function scanSemanticFiles(projectDir, options) {
  const files = [];
  const scan = {
    files,
    skippedIgnored: 0,
    skippedUnsupported: 0,
    skippedLarge: 0,
    maxFilesHit: false,
  };

  const walk = (absDir, relDir = '') => {
    if (files.length >= options.maxSemanticFiles) {
      scan.maxFilesHit = true;
      return;
    }

    let entries = [];
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= options.maxSemanticFiles) {
        scan.maxFilesHit = true;
        return;
      }

      const relPath = toGitPath(relDir ? `${relDir}/${entry.name}` : entry.name);
      if (shouldIgnorePath(entry.isDirectory() ? `${relPath}/` : relPath, options.ignorePatterns)) {
        scan.skippedIgnored += 1;
        continue;
      }

      const absPath = join(projectDir, relPath);
      if (entry.isDirectory()) {
        walk(absPath, relPath);
        continue;
      }

      if (!isSemanticSourcePath(relPath)) {
        scan.skippedUnsupported += 1;
        continue;
      }

      let size = 0;
      try {
        size = statSync(absPath).size;
      } catch {
        continue;
      }
      if (size > options.maxSemanticFileBytes) {
        scan.skippedLarge += 1;
        continue;
      }

      files.push({
        path: relPath,
        absPath,
        size,
        category: categorizeFile(relPath),
      });
    }
  };

  walk(projectDir);
  return scan;
}

function parseSemanticFile(file) {
  const text = readSemanticText(file.absPath);
  return {
    path: file.path,
    category: file.category,
    size: file.size,
    role: inferModuleRole(file.path, file.category),
    imports: {
      local: [],
      external: [],
    },
    rawImports: parseImportSpecifiers(text),
    exports: parseExportNames(text).slice(0, 40),
    unresolvedLocalImports: [],
  };
}

function readSemanticText(path) {
  try {
    const buffer = readFileSync(path);
    if (buffer.includes(0)) return '';
    return buffer.toString('utf-8');
  } catch {
    return '';
  }
}

function parseImportSpecifiers(text) {
  const specs = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specs.push(match[1]);
  }
  return dedupeStrings(specs).slice(0, 80);
}

function parseExportNames(text) {
  const names = [];
  const declarationPattern = /\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(declarationPattern)) names.push(match[1]);

  const listPattern = /\bexport\s*\{([^}]+)\}/g;
  for (const match of text.matchAll(listPattern)) {
    for (const rawName of match[1].split(',')) {
      const name = rawName.trim().split(/\s+as\s+/i).at(-1)?.trim();
      if (name) names.push(name);
    }
  }

  const cjsPattern = /\b(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=/g;
  for (const match of text.matchAll(cjsPattern)) names.push(match[1]);
  if (/\bexport\s+default\b/.test(text) || /\bmodule\.exports\s*=/.test(text)) names.push('default');
  return dedupeStrings(names);
}

function resolveModuleImports(record, indexedPaths) {
  const imports = {
    local: [],
    external: [],
  };
  const unresolvedLocalImports = [];

  for (const specifier of record.rawImports) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const resolvedPath = resolveLocalImportPath(record.path, specifier, indexedPaths);
      if (resolvedPath) {
        imports.local.push({
          specifier,
          path: resolvedPath,
        });
      } else {
        unresolvedLocalImports.push(specifier);
      }
    } else {
      imports.external.push(externalPackageName(specifier));
    }
  }

  return {
    imports: {
      local: dedupeObjects(imports.local, (item) => `${item.specifier}:${item.path}`).slice(0, 40),
      external: dedupeStrings(imports.external).slice(0, 40),
    },
    unresolvedLocalImports: dedupeStrings(unresolvedLocalImports).slice(0, 20),
  };
}

function resolveLocalImportPath(fromPath, specifier, indexedPaths) {
  const base = toGitPath(join(dirname(fromPath), specifier)).replace(/^\/+/, '');
  const extensions = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
  const candidates = [];

  for (const extension of extensions) candidates.push(`${base}${extension}`);
  for (const extension of extensions.filter(Boolean)) candidates.push(`${base}/index${extension}`);

  for (const candidate of candidates.map((item) => toGitPath(item))) {
    if (indexedPaths.has(candidate)) return candidate;
  }
  return null;
}

function buildReverseImports(records) {
  const reverse = new Map();
  for (const record of records) {
    for (const item of record.imports.local) {
      if (!reverse.has(item.path)) reverse.set(item.path, []);
      reverse.get(item.path).push(record.path);
    }
  }
  for (const [path, dependents] of reverse.entries()) {
    reverse.set(path, dedupeStrings(dependents).sort());
  }
  return reverse;
}

function detectEntrypoints(packageProfile, records, indexedPaths) {
  const entrypoints = [];
  for (const target of packageProfile.entrypoints || []) {
    const resolvedPath = resolvePackageEntryPath(target, indexedPaths);
    if (resolvedPath) {
      entrypoints.push({
        path: resolvedPath,
        reason: 'package-entry',
      });
    }
  }

  for (const record of records) {
    if (looksLikeEntrypointPath(record.path)) {
      entrypoints.push({
        path: record.path,
        reason: 'entrypoint-name',
      });
    }
  }

  return dedupeObjects(entrypoints, (item) => item.path)
    .slice(0, 40)
    .map((item) => ({
      ...item,
      category: categorizeFile(item.path),
      role: inferModuleRole(item.path, categorizeFile(item.path)),
    }));
}

function resolvePackageEntryPath(target, indexedPaths) {
  const normalized = toGitPath(String(target || '')).replace(/^\.\//, '');
  const extensions = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
  for (const extension of extensions) {
    const candidate = `${normalized}${extension}`;
    if (indexedPaths.has(candidate)) return candidate;
  }
  return null;
}

function buildChangedSemanticModules({ changedFiles, byPath, reverseImports, entrypointSet, records }) {
  const recordsByPath = new Map(records.map((record) => [record.path, record]));
  return changedFiles.files
    .filter((file) => file.category === 'source' || file.category === 'test' || file.category === 'config')
    .slice(0, 120)
    .map((file) => {
      const record = byPath.get(file.path);
      if (!record) {
        return {
          path: file.path,
          category: file.category,
          role: inferModuleRole(file.path, file.category),
          indexed: false,
          reason: isSemanticSourcePath(file.path) ? 'not-indexed-or-too-large' : 'not-a-js-ts-module',
          directDependents: [],
          relatedTests: [],
          impactedEntrypoints: [],
        };
      }

      const directDependents = (reverseImports.get(file.path) || []).slice(0, DEFAULT_SEMANTIC_MAX_DEPENDENTS);
      const relatedTests = findRelatedTests(file.path, record, recordsByPath, reverseImports)
        .slice(0, DEFAULT_SEMANTIC_MAX_RELATED_TESTS);
      const impactedEntrypoints = findImpactedEntrypoints(file.path, reverseImports, entrypointSet)
        .slice(0, DEFAULT_SEMANTIC_MAX_DEPENDENTS);

      return {
        path: file.path,
        category: file.category,
        role: record.role,
        indexed: true,
        exports: record.exports.slice(0, 12),
        localImports: record.imports.local.slice(0, 12),
        externalImports: record.imports.external.slice(0, 12),
        unresolvedLocalImports: record.unresolvedLocalImports.slice(0, 8),
        directDependents,
        relatedTests,
        impactedEntrypoints,
        evidenceValue: semanticEvidenceValue({ file, directDependents, relatedTests, impactedEntrypoints }),
      };
    })
    .sort((a, b) => (b.evidenceValue || 0) - (a.evidenceValue || 0));
}

function findRelatedTests(path, record, recordsByPath, reverseImports) {
  const related = new Set();
  for (const dependent of reverseImports.get(path) || []) {
    const dependentRecord = recordsByPath.get(dependent);
    if (dependentRecord?.category === 'test') related.add(dependent);
  }

  const base = basenameWithoutExtension(path).toLowerCase();
  for (const testRecord of recordsByPath.values()) {
    if (testRecord.category !== 'test') continue;
    const importsChangedPath = testRecord.imports.local.some((item) => item.path === path);
    if (importsChangedPath || testRecord.path.toLowerCase().includes(base)) related.add(testRecord.path);
  }

  if (record.category === 'test') related.add(record.path);
  return [...related].sort();
}

function findImpactedEntrypoints(path, reverseImports, entrypointSet) {
  const impacted = new Set();
  const seen = new Set([path]);
  const queue = [{ path, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift();
    if (item.depth >= 2) continue;
    for (const dependent of reverseImports.get(item.path) || []) {
      if (entrypointSet.has(dependent)) impacted.add(dependent);
      if (!seen.has(dependent)) {
        seen.add(dependent);
        queue.push({ path: dependent, depth: item.depth + 1 });
      }
    }
  }

  return [...impacted].sort();
}

function summarizeSemanticImpact(changedModules) {
  return {
    changedModules: changedModules.length,
    indexedChangedModules: changedModules.filter((item) => item.indexed).length,
    withDirectDependents: changedModules.filter((item) => item.directDependents?.length > 0).length,
    withRelatedTests: changedModules.filter((item) => item.relatedTests?.length > 0).length,
    withImpactedEntrypoints: changedModules.filter((item) => item.impactedEntrypoints?.length > 0).length,
    notIndexed: changedModules.filter((item) => !item.indexed).length,
  };
}

function semanticEvidenceValue({ file, directDependents, relatedTests, impactedEntrypoints }) {
  let value = fileReviewScore(file);
  if (directDependents.length > 0) value += 20;
  if (relatedTests.length > 0) value += 16;
  if (impactedEntrypoints.length > 0) value += 28;
  return value;
}

function isSemanticSourcePath(path) {
  return /\.[cm]?[jt]sx?$/.test(String(path || '').toLowerCase());
}

function externalPackageName(specifier) {
  const parts = String(specifier || '').split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function looksLikeEntrypointPath(path) {
  const lower = String(path || '').toLowerCase();
  return /(^|\/)(main|index|app|cli|server|worker|router|routes)\.[cm]?[jt]sx?$/.test(lower)
    || /(^|\/)(pages|app|routes)\//.test(lower);
}

function inferModuleRole(path, category) {
  const lower = String(path || '').toLowerCase();
  if (category === 'test') return 'test';
  if (category === 'ci') return 'ci';
  if (category === 'config') return 'config';
  if (looksLikeEntrypointPath(path)) return 'entrypoint';
  if (/\.(jsx|tsx)$/.test(lower) || /(^|\/)(components|views|pages|ui)\//.test(lower)) return 'ui';
  if (/(^|\/)(api|server|routes|controllers)\//.test(lower)) return 'server';
  if (/(^|\/)(state|store|redux|zustand)\//.test(lower)) return 'state';
  if (/(^|\/)(utils?|helpers?|lib)\//.test(lower)) return 'utility';
  if (/(^|\/)(core|engine|graph|model|domain)\//.test(lower)) return 'core';
  return category || 'module';
}

function basenameWithoutExtension(path) {
  return basename(String(path || '')).replace(/\.[^.]+$/, '');
}

export function buildSuggestedEvidence({ changedFiles, packageProfile, availableCommands }) {
  const categories = changedFiles.summary.byCategory;
  const suggestions = [];
  const has = (name) => availableCommands.some((item) => item.family === name);

  if (categories.source && has('test')) {
    suggestions.push(evidenceSuggestion('run-tests', 'Run the nearest project test command.', commandsByFamily(availableCommands, 'test')));
  }
  if ((categories.source || categories.config) && has('typecheck')) {
    suggestions.push(evidenceSuggestion('run-typecheck', 'Collect typecheck output for changed source/config paths.', commandsByFamily(availableCommands, 'typecheck')));
  }
  if ((categories.source || categories.config || categories.visual) && has('lint')) {
    suggestions.push(evidenceSuggestion('run-lint', 'Collect lint output for static mistakes introduced by the change.', commandsByFamily(availableCommands, 'lint')));
  }
  if ((categories.visual || categories.config || categories.docs) && has('build')) {
    suggestions.push(evidenceSuggestion('run-build', 'Collect build output because the change can affect generated/runtime output.', commandsByFamily(availableCommands, 'build')));
  }
  if (categories.docs) {
    suggestions.push(evidenceSuggestion('docs-preview', 'Open or build changed docs pages and check examples/links/headings.', commandsByFamily(availableCommands, 'docs')));
  }
  if (categories.ci) {
    suggestions.push(evidenceSuggestion('review-ci-security', 'Inspect workflow permissions, secrets, triggers, and release paths.', []));
  }
  if (categories.visual) {
    suggestions.push(evidenceSuggestion('visual-before-after', 'Capture or inspect before/after visual output for changed assets/styles/rendering.', []));
  }

  if (suggestions.length === 0 && packageProfile.scripts.length > 0) {
    suggestions.push(evidenceSuggestion('project-smoke', 'Run the cheapest standard project smoke command.', availableCommands.slice(0, 3).map((item) => item.command)));
  }
  return dedupeById(suggestions);
}

export function parseCompactBudget(value) {
  if (value === null || value === undefined || value === false || value === '') return null;
  if (value === true) return DEFAULT_COMPACT_BUDGET_TOKENS;

  const raw = String(value).trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) {
    throw new Error(`Invalid compact budget "${value}". Use a number of tokens, for example 8000, 8k, or 20k.`);
  }

  const factor = match[2] === 'm' ? 1000000 : match[2] === 'k' ? 1000 : 1;
  const tokens = Math.floor(Number(match[1]) * factor);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw new Error(`Invalid compact budget "${value}". Budget must be a positive token count.`);
  }
  return tokens;
}

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

export function buildRecommendedPrompt(pack, options = {}) {
  const promptConfig = pack.config?.prompt || normalizeProjectConfig({}).prompt;
  const compactBudget = parseCompactBudget(options.compactBudget ?? promptConfig.compactBudget);
  const evidenceView = compactBudget
    ? buildPromptCompactView(pack, compactBudget, promptConfig)
    : buildPromptEvidenceView(pack, promptConfig);

  return renderRecommendedPrompt(redactObject(promptConfig), redactObject(evidenceView));
}

function buildPromptEvidenceView(pack, promptConfig) {
  return {
    changeSummary: pack.changeSummary,
    config: {
      source: pack.config?.source,
      promptProfile: promptConfig.profile,
      ignorePatterns: pack.config?.ignorePatterns,
    },
    packageProfile: {
      name: pack.packageProfile.name,
      packageManager: pack.packageProfile.packageManager,
      scriptFamilies: pack.packageProfile.scriptFamilies,
    },
    changedFiles: promptChangedFiles(pack.changedFiles?.files || []).slice(0, DEFAULT_PROMPT_FILE_LIMIT),
    diffSnippets: promptDiffSnippets(pack.diffSnippets || [], DEFAULT_PROMPT_DIFF_LIMIT, DEFAULT_PROMPT_DIFF_CHARS),
    riskSignals: pack.riskSignals,
    missingEvidence: pack.missingEvidence,
    suggestedEvidenceToCollect: pack.suggestedEvidenceToCollect,
    executedCommands: pack.executedCommands.map((item) => promptCommand(item, DEFAULT_PROMPT_COMMAND_CHARS)),
    openQuestionsForAI: pack.openQuestionsForAI,
  };
}

function buildPromptCompactView(pack, budgetTokens, promptConfig) {
  const allFiles = prioritizeChangedFiles(pack.changedFiles?.files || []);
  const allDiffs = prioritizeDiffSnippets(pack.diffSnippets || [], allFiles);
  const allCommands = prioritizeCommands(pack.executedCommands || []);
  const view = {
    changeSummary: pack.changeSummary,
    config: {
      source: pack.config?.source,
      promptProfile: promptConfig.profile,
      ignorePatterns: pack.config?.ignorePatterns,
    },
    packageProfile: {
      name: pack.packageProfile.name,
      packageManager: pack.packageProfile.packageManager,
      scriptFamilies: pack.packageProfile.scriptFamilies,
    },
    changedFiles: [],
    diffSnippets: [],
    riskSignals: pack.riskSignals,
    missingEvidence: pack.missingEvidence,
    suggestedEvidenceToCollect: pack.suggestedEvidenceToCollect,
    executedCommands: [],
    openQuestionsForAI: pack.openQuestionsForAI,
    compaction: {
      enabled: true,
      budgetTokens,
      estimateMethod: 'rough-char-count-divided-by-4',
      note: 'Full collected metadata and budgeted evidence text remain available in evidence.json; this prompt view is budgeted for AI handoff.',
      policy: 'Keep summary, risks, missing evidence, and validation commands first; spend remaining budget on high-score file and diff evidence.',
      included: {
        changedFiles: 0,
        diffSnippets: 0,
        executedCommands: 0,
      },
      omitted: {
        changedFiles: allFiles.length,
        diffSnippets: allDiffs.length,
        executedCommands: allCommands.length,
      },
      truncated: {
        diffSnippets: 0,
        commandOutputs: 0,
      },
      estimatedTokens: 0,
      fitsBudget: false,
    },
  };

  for (const command of allCommands) {
    const compactCommand = largestFittingCommand(view, command, budgetTokens, promptConfig);
    if (!compactCommand) break;
    view.executedCommands.push(compactCommand);
  }

  let nextFileIndex = 0;
  const initialFileBudgetTokens = Math.max(600, Math.floor(budgetTokens * 0.32));
  for (; nextFileIndex < allFiles.length; nextFileIndex += 1) {
    if (view.changedFiles.length >= DEFAULT_PROMPT_FILE_LIMIT) break;
    const item = promptChangedFile(allFiles[nextFileIndex]);
    if (!pushIfPromptFits(view, 'changedFiles', item, budgetTokens, promptConfig)) break;
    if (estimateTokens(JSON.stringify(view.changedFiles)) > initialFileBudgetTokens) {
      view.changedFiles.pop();
      break;
    }
  }

  for (const snippet of allDiffs) {
    if (view.diffSnippets.length >= DEFAULT_PROMPT_DIFF_LIMIT) break;
    const compactSnippet = largestFittingDiffSnippet(view, snippet, budgetTokens, promptConfig);
    if (compactSnippet) view.diffSnippets.push(compactSnippet);
  }

  for (; nextFileIndex < allFiles.length; nextFileIndex += 1) {
    if (view.changedFiles.length >= DEFAULT_PROMPT_FILE_LIMIT) break;
    if (!pushIfPromptFits(view, 'changedFiles', promptChangedFile(allFiles[nextFileIndex]), budgetTokens, promptConfig)) break;
  }

  view.compaction.included.changedFiles = view.changedFiles.length;
  view.compaction.included.diffSnippets = view.diffSnippets.length;
  view.compaction.included.executedCommands = view.executedCommands.length;
  view.compaction.omitted.changedFiles = Math.max(0, allFiles.length - view.changedFiles.length);
  view.compaction.omitted.diffSnippets = Math.max(0, allDiffs.length - view.diffSnippets.length);
  view.compaction.omitted.executedCommands = Math.max(0, allCommands.length - view.executedCommands.length);
  view.compaction.truncated.diffSnippets = view.diffSnippets.filter((item) => item.promptTruncated).length;
  view.compaction.truncated.commandOutputs = view.executedCommands.filter((item) => item.stdoutTruncated || item.stderrTruncated).length;
  view.compaction.estimatedTokens = estimateTokens(renderRecommendedPrompt(promptConfig, view));
  view.compaction.fitsBudget = view.compaction.estimatedTokens <= budgetTokens;

  return view;
}

function renderRecommendedPrompt(promptConfig, evidenceView) {
  return [
    '# AI Change Review Prompt',
    '',
    'You are continuing or reviewing a local AI-assisted coding task from a recorded evidence pack.',
    `Prompt profile: ${promptConfig.profile}.`,
    '',
    'Use the evidence below. Do not invent facts that are not supported by the evidence. If evidence is missing, say exactly what to collect next.',
    ...(promptConfig.instructions.length > 0
      ? [
          '',
          'Project-specific instructions:',
          ...promptConfig.instructions.map((item) => `- ${item}`),
        ]
      : []),
    '',
    'Return:',
    ...(promptConfig.responseFormat.length > 0
      ? promptConfig.responseFormat.map((item, index) => `${index + 1}. ${item}`)
      : [
          '1. Current task understanding grounded in the evidence.',
          '2. The likely blocker or next smallest experiment.',
          '3. Do-not-repeat warnings or failed paths to avoid.',
          '4. Missing evidence that should be collected before a stronger claim.',
          '5. The exact command or file inspection to run next.',
        ]),
    '',
    'Evidence JSON:',
    '',
    '```json',
    JSON.stringify(evidenceView, null, 2),
    '```',
    '',
  ].join('\n');
}

function pushIfPromptFits(view, key, item, budgetTokens, promptConfig) {
  view[key].push(item);
  if (estimateTokens(renderRecommendedPrompt(promptConfig, view)) <= budgetTokens) return true;
  view[key].pop();
  return false;
}

function largestFittingDiffSnippet(view, snippet, budgetTokens, promptConfig) {
  for (const maxChars of diffPromptCharSteps(snippet)) {
    const item = promptDiffSnippet(snippet, maxChars);
    view.diffSnippets.push(item);
    const fits = estimateTokens(renderRecommendedPrompt(promptConfig, view)) <= budgetTokens;
    view.diffSnippets.pop();
    if (fits) return item;
  }
  return null;
}

function largestFittingCommand(view, command, budgetTokens, promptConfig) {
  for (const maxChars of [DEFAULT_PROMPT_COMMAND_CHARS, 800, 400, 160, 0]) {
    const item = promptCommand(command, maxChars);
    view.executedCommands.push(item);
    const fits = estimateTokens(renderRecommendedPrompt(promptConfig, view)) <= budgetTokens;
    view.executedCommands.pop();
    if (fits) return item;
  }
  return null;
}

function promptChangedFiles(files) {
  return files.map(promptChangedFile);
}

function promptChangedFile(file) {
  return {
    status: file.status,
    path: file.path,
    previousPath: file.previousPath || null,
    category: file.category,
    additions: file.additions || 0,
    deletions: file.deletions || 0,
    untracked: Boolean(file.untracked),
    reviewScore: fileReviewScore(file),
    selectionReason: fileSelectionReason(file),
  };
}

function promptDiffSnippets(snippets, limit, maxChars) {
  return snippets.slice(0, limit).map((snippet) => promptDiffSnippet(snippet, maxChars));
}

function promptDiffSnippet(snippet, maxChars) {
  const sourceText = redactText(snippet.text || '');
  return {
    path: snippet.path,
    kind: snippet.kind,
    category: snippet.category,
    reviewScore: snippet.reviewScore,
    selectionReason: snippet.selectionReason,
    truncated: Boolean(snippet.truncated),
    promptTruncated: sourceText.length > maxChars,
    text: preview(sourceText, maxChars),
  };
}

function promptCommand(command, maxChars) {
  const stdout = redactText(command.stdout || '');
  const stderr = redactText(command.stderr || '');
  const item = {
    command: redactText(command.command || ''),
    exitCode: command.exitCode,
    timedOut: Boolean(command.timedOut),
    durationMs: command.durationMs,
    reviewScore: commandEvidencePriority(command),
    selectionReason: commandSelectionReason(command),
  };
  if (maxChars > 0) {
    item.stdoutPreview = preview(stdout, maxChars);
    item.stderrPreview = preview(stderr, maxChars);
  }
  item.stdoutTruncated = stdout.length > maxChars;
  item.stderrTruncated = stderr.length > maxChars;
  return item;
}

function prioritizeCommands(commands) {
  return [...commands].sort((a, b) => {
    const priority = commandEvidencePriority(b) - commandEvidencePriority(a);
    if (priority !== 0) return priority;
    return String(a.command || '').localeCompare(String(b.command || ''));
  });
}

function commandSelectionReason(command) {
  const reasons = [];
  if (command.exitCode !== 0) reasons.push('failure-output');
  if (command.timedOut) reasons.push('timeout');
  if (commandLooksLike(command.command, 'test')) reasons.push('test-evidence');
  if (commandLooksLike(command.command, 'typecheck')) reasons.push('typecheck-evidence');
  if (commandLooksLike(command.command, 'lint')) reasons.push('lint-evidence');
  if (commandLooksLike(command.command, 'build')) reasons.push('build-evidence');
  if (reasons.length === 0) reasons.push('requested-command');
  return reasons;
}

function diffPromptCharSteps(snippet) {
  const max = Math.min(DEFAULT_PROMPT_DIFF_CHARS, diffPromptMaxChars(snippet));
  return [max, 2500, 1200, 600, 240, 80]
    .filter((value, index, values) => value > 0 && value <= max && values.indexOf(value) === index)
    .sort((a, b) => b - a);
}

function diffPromptMaxChars(snippet) {
  if (isLikelyGeneratedPath(snippet.path)) return 240;
  if (isLockfile(snippet.path)) return 400;
  if (snippet.category === 'data' || snippet.category === 'visual') return 800;
  if (snippet.category === 'docs') return 1600;
  if (snippet.category === 'ci' || snippet.category === 'config') return DEFAULT_PROMPT_DIFF_CHARS;
  return 3000;
}

function prioritizeChangedFiles(files) {
  return [...files].sort((a, b) => {
    const score = fileReviewScore(b) - fileReviewScore(a);
    if (score !== 0) return score;
    const size = ((b.additions || 0) + (b.deletions || 0)) - ((a.additions || 0) + (a.deletions || 0));
    if (size !== 0) return size;
    return String(a.path || '').localeCompare(String(b.path || ''));
  });
}

function prioritizeDiffSnippets(snippets, prioritizedFiles) {
  const rank = new Map(prioritizedFiles.map((file, index) => [file.path, index]));
  return [...snippets].sort((a, b) => {
    const aRank = rank.has(a.path) ? rank.get(a.path) : Number.MAX_SAFE_INTEGER;
    const bRank = rank.has(b.path) ? rank.get(b.path) : Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return String(a.path || '').localeCompare(String(b.path || ''));
  });
}

function fileReviewScore(file) {
  const categoryScore = {
    ci: 100,
    config: 90,
    source: 80,
    test: 66,
    visual: 52,
    docs: 42,
    data: 30,
    other: 24,
  };
  let score = categoryScore[file.category] ?? 20;
  const churn = (file.additions || 0) + (file.deletions || 0);
  score += Math.min(20, Math.log2(churn + 1) * 4);
  if (file.status === 'D') score += 8;
  if (file.status === 'R') score += 6;
  if (file.untracked) score += 3;
  if (isLikelyGeneratedPath(file.path)) score -= 35;
  if (isLockfile(file.path)) score -= 18;
  return Math.max(1, Math.round(score));
}

function fileSelectionReason(file) {
  const reasons = [];
  if (file.category) reasons.push(`${file.category}-surface`);
  if (file.status === 'D') reasons.push('deletion');
  if (file.status === 'R') reasons.push('rename');
  if (file.untracked) reasons.push('untracked');
  const churn = (file.additions || 0) + (file.deletions || 0);
  if (churn >= 200) reasons.push('large-churn');
  if (isLockfile(file.path)) reasons.push('lockfile-downranked');
  if (isLikelyGeneratedPath(file.path)) reasons.push('generated-downranked');
  return reasons;
}

function isLockfile(path) {
  return /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|poetry\.lock|cargo\.lock|gemfile\.lock)$/i.test(String(path || ''));
}

function isConfigPath(path) {
  const lower = String(path || '').toLowerCase();
  return /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|poetry\.lock|cargo\.lock|gemfile\.lock)$/.test(lower)
    || /(^|\/)(vite|next|webpack|rollup|tsup|eslint|prettier|tailwind|postcss|babel|jest|vitest|tsconfig|jsconfig)(\.[\w-]+)?\.(config\.)?[cm]?[jt]s(on)?$/.test(lower)
    || /(^|\/)(tsconfig|jsconfig|biome|eslint|prettier)\.json$/.test(lower);
}

function isLikelyGeneratedPath(path) {
  const lower = String(path || '').toLowerCase();
  return /(^|\/)(dist|build|out|coverage|generated|__generated__|vendor)\//.test(lower)
    || /\.min\.[cm]?js$/.test(lower)
    || /\.(snap|snapshot)$/.test(lower);
}

function collectionMode(options) {
  if (options.staged) return 'staged';
  if (options.since) return 'since';
  return 'working-tree';
}

async function collectChangedFiles({ repoRoot, projectDir, scopePath, options }) {
  const diffArgs = diffArgsFor(options);
  const nameStatusText = await gitOutput(repoRoot, [...diffArgs.nameStatus, '--', scopePath], options);
  const numstatText = await gitOutput(repoRoot, [...diffArgs.numstat, '--', scopePath], options);
  const stats = parseNumstat(numstatText);
  const filesByPath = new Map();

  for (const item of parseNameStatus(nameStatusText)) {
    const path = stripScope(item.path, scopePath);
    if (shouldIgnorePath(path, options.ignorePatterns)) continue;
    filesByPath.set(path, {
      status: item.status,
      path,
      previousPath: item.previousPath ? stripScope(item.previousPath, scopePath) : null,
      additions: stats.get(item.path)?.additions ?? 0,
      deletions: stats.get(item.path)?.deletions ?? 0,
      category: categorizeFile(path),
      untracked: false,
    });
  }

  if (options.includeUntracked) {
    const untrackedText = await gitOutput(repoRoot, ['ls-files', '--others', '--exclude-standard', '--', scopePath], options);
    for (const rawPath of untrackedText.split(/\r?\n/).filter(Boolean)) {
      const path = stripScope(rawPath, scopePath);
      if (shouldIgnorePath(path, options.ignorePatterns)) continue;
      if (filesByPath.has(path)) continue;
      filesByPath.set(path, {
        status: 'A',
        path,
        previousPath: null,
        additions: countFileLines(join(projectDir, path)),
        deletions: 0,
        category: categorizeFile(path),
        untracked: true,
      });
    }
  }

  const files = [...filesByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return buildChangedFilesSummary(files);
}

function buildChangedFilesSummary(files) {
  return {
    summary: {
      total: files.length,
      additions: files.reduce((sum, file) => sum + (file.additions || 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions || 0), 0),
      byCategory: countBy(files, 'category'),
      byStatus: countBy(files, 'status'),
    },
    files,
  };
}

async function collectDiffSnippets({ repoRoot, projectDir, scopePath, changedFiles, options }) {
  const snippets = [];
  const files = prioritizeChangedFiles(changedFiles.files).slice(0, options.maxFiles);
  const budget = {
    consideredFiles: changedFiles.files.length,
    eligibleFiles: files.length,
    includedSnippets: 0,
    omittedByMaxFiles: Math.max(0, changedFiles.files.length - files.length),
    omittedByTextBudget: 0,
    truncatedSnippets: 0,
    textBytes: 0,
    maxDiffBytesPerFile: options.maxDiffBytes,
    maxDiffTextBytes: options.maxDiffTextBytes,
  };
  let remainingTextBytes = options.maxDiffTextBytes;

  for (const file of files) {
    if (remainingTextBytes <= 0) {
      budget.omittedByTextBudget += 1;
      continue;
    }

    const perFileBudget = Math.max(0, Math.min(options.maxDiffBytes, remainingTextBytes));
    const score = fileReviewScore(file);
    const reason = fileSelectionReason(file);
    if (file.untracked) {
      const text = readFilePreview(join(projectDir, file.path), perFileBudget);
      const textBytes = Buffer.byteLength(text, 'utf-8');
      snippets.push({
        path: file.path,
        kind: 'untracked-preview',
        category: file.category,
        reviewScore: score,
        selectionReason: reason,
        truncated: text.includes('...[truncated]'),
        textBytes,
        text,
      });
      if (text.includes('...[truncated]')) budget.truncatedSnippets += 1;
      budget.textBytes += textBytes;
      budget.includedSnippets += 1;
      remainingTextBytes = Math.max(0, remainingTextBytes - textBytes);
      continue;
    }

    const scopedPath = scopePath === '.' ? file.path : `${scopePath}/${file.path}`;
    const args = diffForFileArgs(options, scopedPath);
    const result = await tryGitOutput(repoRoot, args, options);
    const originalBytes = Buffer.byteLength(result, 'utf-8');
    const text = trimBytes(result, perFileBudget);
    const textBytes = Buffer.byteLength(text, 'utf-8');
    const truncated = originalBytes > perFileBudget;
    snippets.push({
      path: file.path,
      kind: 'git-diff',
      category: file.category,
      reviewScore: score,
      selectionReason: reason,
      truncated,
      originalBytes,
      textBytes,
      text,
    });
    if (truncated) budget.truncatedSnippets += 1;
    budget.textBytes += textBytes;
    budget.includedSnippets += 1;
    remainingTextBytes = Math.max(0, remainingTextBytes - textBytes);
  }
  budget.omittedByTextBudget += Math.max(0, files.length - snippets.length - budget.omittedByTextBudget);
  return { snippets, budget };
}

function readPackageProfile(projectDir) {
  const pkgPath = join(projectDir, 'package.json');
  if (!existsSync(pkgPath)) {
    return {
      source: 'none',
      name: basename(projectDir),
      packageManager: null,
      scripts: [],
      scriptFamilies: {},
      dependencies: [],
      devDependencies: [],
      workspaces: null,
    };
  }

  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    pkg = {};
  }
  const scripts = Object.keys(pkg.scripts || {});
  return {
    source: 'package-json',
    name: pkg.name || basename(projectDir),
    packageManager: detectPackageManager(projectDir, pkg),
    scripts,
    scriptFamilies: classifyScripts(scripts),
    dependencies: Object.keys(pkg.dependencies || {}),
    devDependencies: Object.keys(pkg.devDependencies || {}),
    workspaces: pkg.workspaces || null,
  };
}

function detectPackageManager(projectDir, pkg) {
  if (pkg.packageManager?.startsWith('pnpm')) return 'pnpm';
  if (pkg.packageManager?.startsWith('yarn')) return 'yarn';
  if (pkg.packageManager?.startsWith('bun')) return 'bun';
  if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectDir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(projectDir, 'bun.lockb')) || existsSync(join(projectDir, 'bun.lock'))) return 'bun';
  return 'npm';
}

function classifyScripts(scripts) {
  const families = {};
  for (const script of scripts) {
    const family = scriptFamily(script);
    if (!families[family]) families[family] = [];
    families[family].push(script);
  }
  return families;
}

function scriptFamily(script) {
  const lower = script.toLowerCase();
  if (lower.includes('typecheck') || lower === 'tsc') return 'typecheck';
  if (lower.includes('test') || lower.includes('vitest') || lower.includes('jest')) return 'test';
  if (lower.includes('lint')) return 'lint';
  if (lower.includes('docs') || lower.includes('storybook')) return 'docs';
  if (lower.includes('build')) return 'build';
  if (lower.includes('release') || lower.includes('publish')) return 'release';
  if (lower.includes('format') || lower.includes('prettier')) return 'format';
  return 'other';
}

export function buildAvailableCommands(packageProfile, projectConfig = normalizeProjectConfig({})) {
  const pm = packageProfile.packageManager || 'npm';
  const run = pm === 'npm' ? 'npm run' : `${pm} run`;
  const commands = [];
  for (const command of projectConfig.preferredCommands || []) {
    commands.push({
      ...command,
      source: 'config',
      priority: 0,
    });
  }
  for (const script of packageProfile.scripts || []) {
    commands.push({
      script,
      family: scriptFamily(script),
      command: `${run} ${script}`,
      source: 'package-json',
      priority: 10,
    });
  }
  return dedupeCommands(commands).sort((a, b) => commandRank(a) - commandRank(b));
}

function commandRank(command) {
  const rank = {
    test: 1,
    typecheck: 2,
    lint: 3,
    build: 4,
    docs: 5,
    format: 6,
    release: 7,
    other: 8,
  };
  return (command.priority || 0) + (rank[command.family] || 99);
}

async function runRequestedCommands(projectDir, options) {
  const results = [];
  for (const command of options.runs) {
    const started = Date.now();
    const result = await runProcess(command, [], {
      cwd: projectDir,
      shell: true,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
    results.push({
      command: redactText(command),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: Date.now() - started,
      stdout: redactText(result.stdout),
      stderr: redactText(result.stderr),
    });
  }
  return results;
}

function applyCommandOutputBudget(commands, maxTotalBytes) {
  const budget = {
    consideredCommands: commands.length,
    includedCommands: commands.length,
    maxCommandOutputTotalBytes: maxTotalBytes,
    textBytes: 0,
    truncatedCommands: 0,
    omittedOutputCommands: 0,
  };
  const remainingByIndex = new Map(commands.map((_, index) => [index, 0]));
  let remaining = maxTotalBytes;

  for (const { command, index } of prioritizeCommandIndexes(commands)) {
    const rawBytes = Buffer.byteLength(command.stdout || '', 'utf-8')
      + Buffer.byteLength(command.stderr || '', 'utf-8');
    const allocation = Math.min(rawBytes, Math.max(0, remaining));
    remainingByIndex.set(index, allocation);
    remaining -= allocation;
  }

  const compacted = commands.map((command, index) => {
    const result = trimCommandOutputToBudget(command, remainingByIndex.get(index) || 0);
    budget.textBytes += Buffer.byteLength(result.stdout || '', 'utf-8')
      + Buffer.byteLength(result.stderr || '', 'utf-8');
    if (result.stdoutTruncated || result.stderrTruncated) budget.truncatedCommands += 1;
    if ((command.stdout || command.stderr) && !result.stdout && !result.stderr) budget.omittedOutputCommands += 1;
    return result;
  });

  return { commands: compacted, budget };
}

export function augmentEvidenceWithCommandEvidence(evidencePack, additionalCommands = []) {
  if (!evidencePack) return evidencePack;

  const executedCommands = mergeCommandEvidence(
    Array.isArray(evidencePack.executedCommands) ? evidencePack.executedCommands : [],
    additionalCommands,
  );
  const changedFiles = evidencePack.changedFiles || {
    summary: { total: 0, byCategory: {} },
    files: [],
  };
  const riskSignals = buildRiskSignals({
    changedFiles,
    executedCommands,
  });
  const missingEvidence = buildMissingEvidence({
    changedFiles,
    suggestedEvidence: evidencePack.suggestedEvidenceToCollect || [],
    executedCommands,
    riskSignals,
  });

  return redactObject({
    ...evidencePack,
    executedCommands,
    riskSignals,
    missingEvidence,
  });
}

function mergeCommandEvidence(existingCommands, additionalCommands) {
  const seen = new Set();
  const merged = [];
  for (const command of [...existingCommands, ...additionalCommands]) {
    if (!command?.command) continue;
    const normalized = {
      ...command,
      command: redactText(command.command),
      exitCode: Number.isFinite(Number(command.exitCode)) ? Number(command.exitCode) : 1,
      timedOut: Boolean(command.timedOut),
      durationMs: Number.isFinite(Number(command.durationMs)) ? Number(command.durationMs) : 0,
      stdout: redactText(command.stdout || ''),
      stderr: redactText(command.stderr || ''),
    };
    const key = [
      normalized.command,
      normalized.exitCode,
      normalized.timedOut ? 'timeout' : 'done',
      normalized.failureSignature || '',
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function prioritizeCommandIndexes(commands) {
  return commands
    .map((command, index) => ({ command, index }))
    .sort((a, b) => {
      const priority = commandEvidencePriority(b.command) - commandEvidencePriority(a.command);
      if (priority !== 0) return priority;
      return a.index - b.index;
    });
}

function commandEvidencePriority(command) {
  let score = 10;
  if (command.exitCode !== 0) score += 60;
  if (command.timedOut) score += 50;
  if (commandLooksLike(command.command, 'test')) score += 30;
  if (commandLooksLike(command.command, 'typecheck')) score += 26;
  if (commandLooksLike(command.command, 'lint')) score += 22;
  if (commandLooksLike(command.command, 'build')) score += 18;
  return score;
}

function trimCommandOutputToBudget(command, maxBytes) {
  const stdout = String(command.stdout || '');
  const stderr = String(command.stderr || '');
  const stderrFirst = command.exitCode !== 0 || command.timedOut;
  const primary = stderrFirst ? stderr : stdout;
  const secondary = stderrFirst ? stdout : stderr;
  const primaryKey = stderrFirst ? 'stderr' : 'stdout';
  const secondaryKey = stderrFirst ? 'stdout' : 'stderr';
  const primaryBytes = Math.floor(maxBytes * (stderrFirst ? 0.7 : 0.8));
  const secondaryBytes = Math.max(0, maxBytes - primaryBytes);
  const trimmed = {
    ...command,
    stdout: '',
    stderr: '',
    outputBudgetBytes: maxBytes,
  };
  const secondaryRawBytes = Buffer.byteLength(secondary, 'utf-8');
  const secondaryReserve = Math.min(secondaryRawBytes, maxBytes - primaryBytes);
  const primaryLimit = Math.max(0, maxBytes - secondaryReserve);
  trimmed[primaryKey] = trimBytes(primary, primaryLimit);
  const primaryUsed = Buffer.byteLength(trimmed[primaryKey], 'utf-8');
  trimmed[secondaryKey] = trimBytes(secondary, Math.max(0, maxBytes - primaryUsed, secondaryBytes));
  trimmed.stdoutTruncated = Buffer.byteLength(stdout, 'utf-8') > Buffer.byteLength(trimmed.stdout, 'utf-8');
  trimmed.stderrTruncated = Buffer.byteLength(stderr, 'utf-8') > Buffer.byteLength(trimmed.stderr, 'utf-8');
  return trimmed;
}

function buildRiskSignals({ changedFiles, executedCommands }) {
  const categories = changedFiles.summary.byCategory;
  const signals = [];
  if (changedFiles.summary.total > 40) {
    signals.push(signal('large-change', 'medium', `Change touches ${changedFiles.summary.total} files; AI should ask for intent and grouping.`));
  }
  if (categories.source && !categories.test) {
    signals.push(signal('source-without-tests', 'medium', 'Source changed without changed tests in this evidence pack.'));
  }
  if (categories.ci) {
    signals.push(signal('ci-or-release-surface', 'medium', 'CI/release automation changed; secrets, permissions, and triggers matter.'));
  }
  if (categories.config) {
    signals.push(signal('config-or-dependency-surface', 'medium', 'Config/package/lock/build metadata changed.'));
  }
  if (categories.visual) {
    signals.push(signal('visual-surface', 'medium', 'Visual assets/styles/rendering changed; textual checks may miss regressions.'));
  }
  if (executedCommands.some((item) => item.exitCode !== 0)) {
    signals.push(signal('command-failure', 'high', 'At least one collected validation command failed.'));
  }
  if (executedCommands.length === 0 && changedFiles.summary.total > 0) {
    signals.push(signal('no-command-evidence', 'low', 'No validation command output was collected yet.'));
  }
  return signals;
}

export function buildMissingEvidence({ changedFiles, suggestedEvidence = [], executedCommands = [], riskSignals = [] }) {
  const categories = changedFiles.summary.byCategory;
  const missing = [];
  const suggestedById = new Map(suggestedEvidence.map((item) => [item.id, item]));
  const commandFailed = executedCommands.some((item) => item.exitCode !== 0);

  if (changedFiles.summary.total === 0) return [];

  if (riskSignals.some((item) => item.id === 'large-change')) {
    missing.push(missingItem({
      id: 'change-intent-and-grouping',
      severity: 'high',
      reason: 'The change is large enough that AI review needs the intended scope and logical groups before giving strong advice.',
      howToCollect: [
        'Ask the human or previous AI session for the intended outcome of this change.',
        'Group changed files by feature, generated output, docs, tests, and cleanup before review.',
      ],
      commands: [],
    }));
  }

  if (categories.source && !hasSuccessfulCommand(executedCommands, ['test'])) {
    const suggestion = suggestedById.get('run-tests');
    missing.push(missingItem({
      id: 'test-output',
      severity: categories.test ? 'medium' : 'high',
      reason: categories.test
        ? 'Source and tests changed, but no successful test command output was collected.'
        : 'Source changed, but no successful test command output was collected.',
      howToCollect: [
        'Run the nearest targeted tests or the project test command.',
        'If tests are intentionally absent, provide the coverage rationale for AI review.',
      ],
      commands: suggestion?.commands || [],
    }));
  }

  if ((categories.source || categories.config) && !hasSuccessfulCommand(executedCommands, ['typecheck'])) {
    const suggestion = suggestedById.get('run-typecheck');
    if (suggestion?.commands?.length) {
      missing.push(missingItem({
        id: 'typecheck-output',
        severity: 'medium',
        reason: 'Source/config changed and a typecheck command is available, but no successful typecheck output was collected.',
        howToCollect: ['Run the project typecheck command and include its output.'],
        commands: suggestion.commands,
      }));
    }
  }

  if ((categories.source || categories.config || categories.visual) && !hasSuccessfulCommand(executedCommands, ['lint'])) {
    const suggestion = suggestedById.get('run-lint');
    if (suggestion?.commands?.length) {
      missing.push(missingItem({
        id: 'lint-output',
        severity: 'medium',
        reason: 'Changed files would benefit from static-check evidence, but no successful lint output was collected.',
        howToCollect: ['Run the project lint/static-analysis command and include its output.'],
        commands: suggestion.commands,
      }));
    }
  }

  if ((categories.config || categories.visual || categories.docs) && !hasSuccessfulCommand(executedCommands, ['build'])) {
    const suggestion = suggestedById.get('run-build');
    if (suggestion?.commands?.length) {
      missing.push(missingItem({
        id: 'build-output',
        severity: 'medium',
        reason: 'Build-affecting files changed, but no successful build output was collected.',
        howToCollect: ['Run the project build command and include its output.'],
        commands: suggestion.commands,
      }));
    }
  }

  if (categories.visual) {
    missing.push(missingItem({
      id: 'visual-before-after',
      severity: 'medium',
      reason: 'Visual assets/styles/rendering changed; textual evidence may miss regressions.',
      howToCollect: [
        'Capture before/after screenshots or rendered asset output for the changed surfaces.',
        'If visual output is not applicable, explain why the change is non-rendering.',
      ],
      commands: suggestedById.get('visual-before-after')?.commands || [],
    }));
  }

  if (categories.docs) {
    missing.push(missingItem({
      id: 'docs-preview',
      severity: 'low',
      reason: 'Docs changed; AI review benefits from generated preview or link/example validation.',
      howToCollect: [
        'Open or build the changed docs pages.',
        'Check changed code examples against the current API.',
      ],
      commands: suggestedById.get('docs-preview')?.commands || [],
    }));
  }

  if (categories.ci) {
    missing.push(missingItem({
      id: 'ci-security-review',
      severity: 'high',
      reason: 'CI/release automation changed; command output alone does not prove the trust boundary is safe.',
      howToCollect: [
        'Review permissions, secrets, triggers, fork exposure, and release environments.',
        'Identify whether this change affects publishing credentials or deploy paths.',
      ],
      commands: [],
    }));
  }

  if (commandFailed) {
    missing.push(missingItem({
      id: 'failure-triage',
      severity: 'high',
      reason: 'A collected command failed; AI needs failure triage before a readiness claim.',
      howToCollect: [
        'Inspect the failing command stderr/stdout.',
        'Determine whether the failure is caused by this change, existing project state, or environment setup.',
      ],
      commands: failedCommands(executedCommands),
    }));
  }

  if (executedCommands.length === 0) {
    missing.push(missingItem({
      id: 'command-output',
      severity: 'medium',
      reason: 'No command output was collected; AI can only reason from static local evidence.',
      howToCollect: ['Run one or more suggested commands and collect output with --run.'],
      commands: dedupeStrings(suggestedEvidence.flatMap((item) => item.commands || [])).slice(0, 6),
    }));
  }

  return dedupeById(missing);
}

function missingItem({ id, severity, reason, howToCollect, commands }) {
  return {
    id,
    severity,
    reason,
    howToCollect: dedupeStrings(howToCollect),
    commands: dedupeStrings(commands),
  };
}

function hasSuccessfulCommand(executedCommands, families) {
  return executedCommands.some((item) => item.exitCode === 0 && families.some((family) => commandLooksLike(item.command, family)));
}

function commandLooksLike(command, family) {
  const lower = String(command || '').toLowerCase();
  if (family === 'test') return /\b(test|vitest|jest|mocha|uvu|pytest)\b/.test(lower);
  if (family === 'typecheck') return /typecheck|\btsc\b/.test(lower);
  if (family === 'lint') return /\b(lint|eslint|biome|oxlint)\b/.test(lower);
  if (family === 'build') return /\b(build|vite build|next build|tsup|rollup|webpack)\b/.test(lower);
  return lower.includes(family);
}

function failedCommands(executedCommands) {
  return executedCommands.filter((item) => item.exitCode !== 0).map((item) => item.command);
}

function buildOpenQuestions({ changedFiles, riskSignals }) {
  const questions = [];
  const categories = changedFiles.summary.byCategory;
  if (riskSignals.some((item) => item.id === 'large-change')) {
    questions.push('Can this change be split into smaller intent groups before the next AI continues?');
  }
  if (categories.source) {
    questions.push('What user-visible behavior or internal contract changed in the source diff?');
  }
  if (categories.test) {
    questions.push('Do the changed tests directly exercise the changed source path?');
  }
  if (categories.ci) {
    questions.push('Do workflow permission, secret, trigger, and release-path changes match the intended trust boundary?');
  }
  if (categories.visual) {
    questions.push('What visual before/after evidence should be inspected?');
  }
  if (categories.docs) {
    questions.push('Do changed docs examples still match the current API and generated site?');
  }
  if (questions.length === 0) {
    questions.push('What is the intended outcome of this local change, and what evidence would prove it?');
  }
  return dedupeStrings(questions);
}

function evidenceSuggestion(id, reason, commands) {
  return {
    id,
    reason,
    commands: dedupeStrings(commands),
  };
}

export function shouldIgnorePath(path, patterns = []) {
  const normalized = toGitPath(path).replace(/^\/+/, '');
  return patterns.some((pattern) => matchesPattern(normalized, pattern));
}

function matchesPattern(path, pattern) {
  const normalizedPattern = toGitPath(pattern).replace(/^\/+/, '');
  if (!normalizedPattern) return false;
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.endsWith('/')) {
    const prefix = normalizedPattern.replace(/\/+$/, '');
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (!normalizedPattern.includes('*')) {
    return path === normalizedPattern || path.startsWith(`${normalizedPattern}/`);
  }
  return globToRegExp(normalizedPattern).test(path);
}

function globToRegExp(pattern) {
  const marker = '\u0000';
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, marker)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(marker, 'g'), '.*');
  return new RegExp(`^${escaped}$`);
}

function normalizePreferredCommands(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    if (typeof item === 'string') {
      return {
        id: `preferred-${index + 1}`,
        script: null,
        family: scriptFamily(item),
        command: item,
        reason: null,
      };
    }
    if (!item || typeof item !== 'object' || typeof item.command !== 'string') return null;
    return {
      id: typeof item.id === 'string' ? item.id : `preferred-${index + 1}`,
      script: typeof item.script === 'string' ? item.script : null,
      family: typeof item.family === 'string' ? item.family : scriptFamily(item.command),
      command: item.command,
      reason: typeof item.reason === 'string' ? item.reason : null,
    };
  }).filter(Boolean);
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function signal(id, severity, message) {
  return { id, severity, message };
}

function commandsByFamily(commands, family) {
  return commands.filter((item) => item.family === family).slice(0, 3).map((item) => item.command);
}

function diffArgsFor(options) {
  if (options.staged) {
    return {
      nameStatus: ['diff', '--cached', '--name-status'],
      numstat: ['diff', '--cached', '--numstat'],
    };
  }
  if (options.since) {
    return {
      nameStatus: ['diff', '--name-status', `${options.since}...HEAD`],
      numstat: ['diff', '--numstat', `${options.since}...HEAD`],
    };
  }
  return {
    nameStatus: ['diff', '--name-status', 'HEAD'],
    numstat: ['diff', '--numstat', 'HEAD'],
  };
}

function diffForFileArgs(options, scopedPath) {
  if (options.staged) return ['diff', '--cached', '--', scopedPath];
  if (options.since) return ['diff', `${options.since}...HEAD`, '--', scopedPath];
  return ['diff', 'HEAD', '--', scopedPath];
}

function parseNameStatus(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split('\t');
    const rawStatus = parts[0];
    const status = rawStatus[0];
    const path = status === 'R' || status === 'C' ? parts[2] : parts[1];
    const previousPath = status === 'R' || status === 'C' ? parts[1] : null;
    return { status, path, previousPath };
  }).filter((file) => file.path);
}

function parseNumstat(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split('\t');
    const additions = Number(parts[0]) || 0;
    const deletions = Number(parts[1]) || 0;
    const path = parts.at(-1);
    map.set(path, { additions, deletions });
  }
  return map;
}

function countFileLines(path) {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return 0;
    const buffer = readFileSync(path);
    if (buffer.includes(0)) return 0;
    const text = buffer.toString('utf-8');
    if (!text) return 0;
    return text.split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

function readFilePreview(path, maxBytes) {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return '';
    const buffer = readFileSync(path);
    if (buffer.includes(0)) return '[binary file omitted]';
    return trimBytes(buffer.toString('utf-8'), maxBytes);
  } catch (error) {
    return `[could not read file: ${error.message}]`;
  }
}

async function gitOutput(cwd, args, options) {
  const result = await runProcess('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    shell: false,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxOutputBytes: Math.max(options.maxOutputBytes || DEFAULT_OUTPUT_BYTES, 5000000),
  });
  if (result.exitCode !== 0) {
    throw new Error(redactText(`git ${args.join(' ')} failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`));
  }
  return result.stdout.trim();
}

async function tryGitOutput(cwd, args, options) {
  try {
    return await gitOutput(cwd, args, options);
  } catch (error) {
    return `[git diff unavailable: ${error.message}]`;
  }
}

export function runProcess(command, args, opts) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: Boolean(opts.shell),
      windowsHide: true,
      env: { ...process.env, CI: process.env.CI || '1' },
    });

    const max = opts.maxOutputBytes || DEFAULT_OUTPUT_BYTES;
    const append = (target, chunk) => {
      const text = chunk.toString();
      const next = target.value + text;
      if (Buffer.byteLength(next) > max) {
        target.truncated = true;
        return trimBytes(next, max);
      }
      return next;
    };

    child.stdout?.on('data', (chunk) => {
      const target = { value: stdout, truncated: stdoutTruncated };
      stdout = append(target, chunk);
      stdoutTruncated = target.truncated;
    });
    child.stderr?.on('data', (chunk) => {
      const target = { value: stderr, truncated: stderrTruncated };
      stderr = append(target, chunk);
      stderrTruncated = target.truncated;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref?.();
    }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: 1,
        signal: null,
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: timedOut ? 124 : (code ?? 1),
        signal,
        timedOut,
        durationMs: Date.now() - started,
        stdout: stdoutTruncated ? `${stdout}\n...[stdout truncated]` : stdout,
        stderr: stderrTruncated ? `${stderr}\n...[stderr truncated]` : stderr,
      });
    });
  });
}

function formatEvidenceMarkdown(pack) {
  const lines = [];
  lines.push('# AI Change Evidence');
  lines.push('');
  lines.push(`- Project: ${pack.collection.projectDir}`);
  lines.push(`- Mode: ${pack.collection.mode}`);
  lines.push(`- Files: ${pack.changedFiles.summary.total}`);
  lines.push(`- Headline: ${pack.changeSummary.headline}`);
  lines.push(`- Config: ${pack.config.source}${pack.config.path ? ` (${pack.config.path})` : ''}`);
  lines.push('');
  if (pack.config.warnings.length > 0) {
    lines.push('## Config Warnings');
    lines.push('');
    for (const warning of pack.config.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  lines.push('## Change Summary');
  lines.push('');
  lines.push(`- Categories: ${formatCountMap(pack.changedFiles.summary.byCategory) || 'none'}`);
  lines.push(`- Traits: ${pack.changeSummary.traits.join(', ') || 'none'}`);
  lines.push('');
  if (pack.evidenceBudget) {
    lines.push('## Evidence Budget');
    lines.push('');
    lines.push(`- Max pack bytes: ${pack.evidenceBudget.limits.maxPackBytes}`);
    lines.push(`- Diff text bytes: ${pack.evidenceBudget.diffSnippets.textBytes}/${pack.evidenceBudget.limits.maxDiffTextBytes}`);
    lines.push(`- Command output bytes: ${pack.evidenceBudget.commandOutputs.textBytes}/${pack.evidenceBudget.limits.maxCommandOutputTotalBytes}`);
    lines.push(`- Diff snippets: ${pack.evidenceBudget.diffSnippets.includedSnippets} included, ${pack.evidenceBudget.diffSnippets.omittedByMaxFiles} omitted by max-files, ${pack.evidenceBudget.diffSnippets.omittedByTextBudget} omitted by text budget`);
    lines.push(`- Truncated: ${pack.evidenceBudget.diffSnippets.truncatedSnippets} diff snippets, ${pack.evidenceBudget.commandOutputs.truncatedCommands} command outputs`);
    lines.push('');
  }
  lines.push('## Risk Signals');
  lines.push('');
  if (pack.riskSignals.length === 0) {
    lines.push('- None');
  } else {
    for (const signalItem of pack.riskSignals) {
      lines.push(`- ${signalItem.severity.toUpperCase()} ${signalItem.id}: ${signalItem.message}`);
    }
  }
  lines.push('');
  lines.push('## Missing Evidence');
  lines.push('');
  if (!pack.missingEvidence || pack.missingEvidence.length === 0) {
    lines.push('- None');
  } else {
    for (const item of pack.missingEvidence) {
      lines.push(`- ${item.severity.toUpperCase()} ${item.id}: ${item.reason}`);
      for (const step of item.howToCollect || []) lines.push(`  - ${step}`);
      for (const command of item.commands || []) lines.push(`  - Command: \`${command}\``);
    }
  }
  lines.push('');
  lines.push('## Suggested Evidence To Collect');
  lines.push('');
  if (pack.suggestedEvidenceToCollect.length === 0) {
    lines.push('- None');
  } else {
    for (const item of pack.suggestedEvidenceToCollect) {
      lines.push(`- ${item.id}: ${item.reason}`);
      for (const command of item.commands || []) lines.push(`  - \`${command}\``);
    }
  }
  lines.push('');
  lines.push('## Changed Files');
  lines.push('');
  lines.push('| Status | Category | +/- | Path |');
  lines.push('| --- | --- | ---: | --- |');
  for (const file of pack.changedFiles.files.slice(0, 120)) {
    const untracked = file.untracked ? ' (untracked)' : '';
    lines.push(`| ${file.status} | ${file.category} | +${file.additions}/-${file.deletions} | ${escapePipes(file.path)}${untracked} |`);
  }
  if (pack.changedFiles.files.length > 120) {
    lines.push(`| ... | ... | ... | ${pack.changedFiles.files.length - 120} more files omitted |`);
  }
  lines.push('');
  lines.push('## Executed Commands');
  lines.push('');
  if (pack.executedCommands.length === 0) {
    lines.push('- None');
  } else {
    for (const command of pack.executedCommands) {
      lines.push(`- ${command.exitCode === 0 ? 'PASS' : 'FAIL'} \`${command.command}\` (${command.durationMs}ms)`);
    }
  }
  lines.push('');
  lines.push('## Open Questions For AI');
  lines.push('');
  for (const question of pack.openQuestionsForAI) lines.push(`- ${question}`);
  return lines.join('\n');
}

function buildChangeHeadline(total, categories, traits) {
  if (total === 0) return 'No local changes detected.';
  const categoryText = formatCountMap(categories);
  const traitText = traits.length ? `; traits: ${traits.join(', ')}` : '';
  return `${total} changed files across ${categoryText}${traitText}.`;
}

function stripScope(path, scopePath) {
  const normalized = toGitPath(path);
  if (!scopePath || scopePath === '.') return normalized;
  const prefix = `${scopePath.replace(/\/$/, '')}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

function toGitPath(path) {
  return String(path || '').replace(/\\/g, '/');
}

function countBy(items, key) {
  const result = {};
  for (const item of items) {
    const value = item[key] || 'unknown';
    result[value] = (result[value] || 0) + 1;
  }
  return result;
}

function formatCountMap(map) {
  return Object.entries(map || {}).map(([key, value]) => `${key}: ${value}`).join(', ');
}

function preview(text, maxChars) {
  const value = String(text || '');
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
}

function trimBytes(text, maxBytes) {
  const value = String(text || '');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const marker = '\n...[truncated]';
  const markerBytes = Buffer.byteLength(marker, 'utf-8');
  if (maxBytes <= markerBytes) {
    return Buffer.from(value).subarray(0, maxBytes).toString('utf-8');
  }
  const bodyBytes = maxBytes - markerBytes;
  return `${Buffer.from(value).subarray(0, bodyBytes).toString('utf-8')}${marker}`;
}

function makeRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function dedupeById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function dedupeCommands(commands) {
  const seen = new Set();
  return (commands || []).filter((item) => {
    if (!item?.command || seen.has(item.command)) return false;
    seen.add(item.command);
    return true;
  });
}

function dedupeStrings(items) {
  const seen = new Set();
  return (items || []).filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function dedupeObjects(items, keyFn) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapePipes(text) {
  return String(text).replace(/\|/g, '\\|');
}
