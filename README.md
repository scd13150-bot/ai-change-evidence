# AI Change Evidence

[![npm version](https://img.shields.io/npm/v/ai-change-evidence)](https://www.npmjs.com/package/ai-change-evidence)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/scd13150/ai-change-evidence/actions/workflows/ci.yml/badge.svg)](https://github.com/scd13150/ai-change-evidence/actions/workflows/ci.yml)

AI Change Evidence (ACE) compiles engineering experience from AI coding attempts into portable handoff evidence.

ACE is not a CodeGraph clone, a generic memory layer, or another AI code generator. It records attempts, failed commands, normalized failure signatures, do-not-repeat notes, validation output, semantic/risk evidence, missing evidence, and a compact packet the next agent can use across sessions, tools, and platforms.

Core promise:

```text
Stop AI coding agents from repeating disproven engineering paths.
```

Status: alpha. The CLI is usable, but packet schemas and integration examples may change.

## Install

From a checkout:

```bash
npm install
npm test
npm link
```

From a published package:

```bash
npm install -g ai-change-evidence
```

Then use the installed bins:

```bash
ace init
ace experience --json
ace-mcp
```

For one-off inspection after the package is published, use:

```bash
npx -p ai-change-evidence ace --help
```

A global install or `npm link` is better for hooks and MCP because Codex needs stable `ace` and `ace-mcp` commands on `PATH`.

## Release Validation

Before publishing an alpha build:

```bash
npm run release:check
```

This runs syntax checks, the test suite, a stdio MCP client smoke, a concurrent-ledger stress test, a packed-tarball install smoke, and `npm pack --dry-run`. The package-install smoke verifies that installed `ace` and `ace-mcp` work outside the source checkout, that `ace init --codex` generates target-project config, and that the generated Stop hook can write ACE handoff artifacts.

Do not publish until `package.json` has the real repository, issue tracker, and homepage URLs. Those are intentionally not guessed from the local checkout.

## 10-Minute First Run

In the project where an AI agent will work:

```bash
ace init
ace start "fix export flow without breaking renderer"
ace run "npm test"
ace note "Do not repeat wasm path rewrite; package exports already failed."
ace experience --json --no-evidence
ace brief --compact 8k
```

`ace start` opens a new active task boundary. Older ledger entries remain on disk for audit/history, but `experience`, `status`, and `brief` summarize the current task by default. Use `ace start --reset` only when you intentionally want to discard the prior local ledger.

The next agent should read `ace experience --json` or `.ace/handoff.md` before editing. The useful difference is simple: the next attempt sees failed commands, normalized failure signatures, and do-not-repeat notes before it proposes another fix.

For Codex desktop:

```bash
ace init --codex
```

Then trust the generated `.codex` config/hooks in Codex and start a fresh desktop thread. See [Codex integration](./docs/codex.md).

## Product Direction

ACE is an engineering experience handoff layer:

1. Capture raw events from an AI coding task.
2. Normalize failures so repeated problems can be recognized across paths, machines, and sessions.
3. Convert notes into do-not-repeat engineering constraints.
4. Add supporting evidence from commands, project scripts, git diff, and optional semantic impact.
5. Produce an experience packet or handoff brief the next agent can act on.

The technical center is the pipeline, not storage:

```text
raw attempts
  -> normalized failures
  -> invalidated paths
  -> evidence and semantic impact
  -> missing-evidence reasoning
  -> compact portable experience packet
```

Git is one evidence source. ACE's core ledger, command capture, failure signatures, notes, and handoff packets are not git-specific.

Non-goals:

- Do not build a CodeGraph clone.
- Do not sell a generic project context manager.
- Do not make pre-push review the only workflow.
- Do not pretend rule heuristics can replace AI judgment.
- Do not require a SaaS backend before local usefulness is proven.

## Quick Start

From this repository:

```bash
npm test

node src/cli.js init
node src/cli.js start "fix export flow without breaking renderer"
node src/cli.js experience --json
node src/cli.js run "npm test"
node src/cli.js note "Do not repeat wasm path rewrite; package exports already failed."
node src/cli.js brief --compact 8k
```

When installed as a package, use `ace` instead of `node src/cli.js`:

```bash
ace init
ace init --codex
ace experience --json
ace run "npm test"
ace brief --compact 8k
```

For MCP-capable agents:

```bash
ace-mcp
```

The main local files are:

```text
<project>/ace.config.json
<project>/AGENTS.md
<project>/.gitignore
<project>/.ace/ledger.json
<project>/.ace/handoff.md
```

## Agent Workflow

Give this workflow to any AI coding agent working in the project:

```text
Before editing:
- Run ace experience --json.
- Read objective, recent timeline, failed commands, do-not-repeat notes, and missing evidence.

During work:
- Run important validation commands through ace run "command".
- Record abandoned paths with ace note "Do not repeat ...".
- Keep the next step small enough to validate.

Before handoff:
- Run ace brief --compact 8k.
- Point the next agent to .ace/handoff.md or provide ace experience --json output.
```

`ace init` writes an `AGENTS.md` with this guidance. It skips existing files by default; pass `--force` only when you intentionally want to overwrite generated files.

## Main Commands

```bash
node src/cli.js init
node src/cli.js init --force
node src/cli.js start "objective"
node src/cli.js start "objective" --reset
node src/cli.js experience --json
node src/cli.js experience --json --no-evidence
node src/cli.js note "what was tried / what not to repeat"
node src/cli.js run "npm test"
node src/cli.js status
node src/cli.js brief --compact 8k
node src/cli.js brief --print --no-evidence
node src/cli.js collect [options]
node src/cli.js doctor [--json]
node src/cli.js export [--out <dir>] [--compact 8k]
node src/cli.js prune [--apply] [--max-age-days <n>]
```

Command roles:

- `init`: creates conservative project scaffolding for agent use and ensures `.gitignore` ignores `.ace/`.
- `experience`: prints a compact machine-readable engineering experience packet.
- `start`: opens a new active task boundary and sets the current AI coding objective; prior entries stay in the ledger as history unless `--reset` is used.
- `note`: records a durable attempt note, including do-not-repeat warnings.
- `run`: executes a command, stores output, exit code, duration, and failure signature.
- `status`: summarizes the current task ledger for humans.
- `brief`: creates `.ace/handoff.md` for the next AI agent.
- `collect`: lower-level evidence collector for current project changes.
- `doctor`: runs health checks on the local ACE setup (config, ledger, validation, git, scripts, policy, retention, integration).
- `export`: creates a portable export bundle with experience, handoff, and doctor artifacts.
- `prune`: cleans up expired ledger entries and run artifacts according to retention policy; `--apply` to actually remove, dry-run by default.

`ace context` is kept as a compatibility alias for `ace experience`.

Task boundary behavior:

- `ace start "objective"` starts a fresh active task inside the existing ledger.
- `ace experience`, `ace status`, and `ace brief` focus on entries from the active task, so old unresolved failures do not pollute a new objective.
- `ace start "objective" --reset` clears the local ledger first.

`experience` is intentionally compact. It does not include full command stdout or stderr; agents should use it as handoff evidence and inspect the ledger or brief only when needed.

The experience packet includes:

- `experienceSummary`: compact status, validation posture, risk ids, and next-action bias.
- `validation`: passed/failed command counts, unresolved failures, resolved historical failures, latest failure, and normalized failure signatures.
- `invalidatedPaths`: do-not-repeat notes and repeated failure patterns that should change the next attempt.
- `missingEvidence`: high-value evidence gaps the next agent should close before strong claims.
- `suggestedNextEvidence`: commands or checks likely to produce useful proof.
- `semanticImpact`: optional bounded import/export/dependent/test/entrypoint impact facts.
- `evidence`: compact changed-file, risk, and evidence-source status.

## Technical Advantages

ACE is more than git data storage:

- Failure signatures normalize paths, line numbers, and unstable numeric details.
- Do-not-repeat notes become structured constraints, not just prose.
- Project scripts are classified into test, lint, typecheck, build, and docs evidence families.
- Risk signals identify surfaces such as source-without-tests, CI/release changes, visual changes, large changes, and command failures.
- Missing evidence describes what proof is still needed before an agent should make a readiness claim.
- Compact packets preserve high-value evidence under a token budget and record omitted/truncated material.
- Optional semantic evidence indexes bounded imports, exports, entrypoints, direct dependents, related tests, and impacted modules.
- Best-effort redaction removes common secret-shaped strings before writing ledgers, evidence packs, and prompts.

The goal is not to store everything. The goal is to preserve the engineering experience that changes the next action.

## Examples

- [Failure handoff](./examples/failure-handoff/README.md): a compact example where the next agent sees a failed command and an invalidated path before continuing.
- [Real project NLE smoke](./examples/real-project-nle-smoke/README.md): a sanitized external-project validation showing ACE preserving both a real passing test command and a do-not-repeat lesson.
- [Codex desktop smoke](./examples/codex-desktop-smoke/README.md): a prompt for testing ACE MCP and hooks in a fresh trusted Codex desktop thread.
- [Claude Code hooks](./examples/claude-code-hooks/settings.example.json): an example stop hook that writes an ACE handoff brief.
- [GitHub PR evidence workflow](./.github/workflows/ace-pr-evidence.yml): an example workflow that comments ACE evidence on same-repository pull requests.

## Handoff Brief

`ace brief` produces a current-task brief with:

- Current objective.
- Recent attempt timeline.
- Failed commands and normalized failure signatures.
- Do-not-repeat items.
- Current change summary.
- Risk signals and missing evidence from the supporting evidence collector.
- Next AI instructions.

This is the human-readable product surface. `ace experience --json` is the machine-readable surface.

## Supporting Evidence Collector

`collect` is available when you need a standalone evidence pack:

```bash
node src/cli.js collect --workdir D:\path\to\project
node src/cli.js collect --workdir D:\path\to\project --staged
node src/cli.js collect --workdir D:\path\to\project --since main
node src/cli.js collect --workdir D:\path\to\project --run "npm test" --run "npm run lint"
node src/cli.js collect --workdir D:\path\to\project --compact 8k --prompt
```

`collect` and evidence-backed `brief`/`experience` currently use git diff data for changed-file evidence. If the target directory is not inside a git repo, ledger commands still work and evidence will be reported as unavailable rather than blocking the packet.

Output files:

```text
<project>/.ace/runs/<timestamp>/evidence.json
<project>/.ace/runs/<timestamp>/evidence.md
<project>/.ace/runs/<timestamp>/prompt.md
```

The evidence pack contains:

- `changeSummary`: compact description of the local change.
- `changedFiles`: status, category, additions, deletions, untracked marker.
- `diffSnippets`: capped diff/file previews for AI inspection.
- `packageProfile`: package manager, scripts, script families, dependencies.
- `semanticProfile`: optional bounded semantic impact facts.
- `executedCommands`: captured command output from `--run`.
- `evidenceBudget`: size limits, truncation counts, and omitted evidence-text counts.
- `riskSignals`: grounded signals such as `source-without-tests`.
- `missingEvidence`: concrete evidence gaps the AI should resolve before strong claims.
- `recommendedPrompt`: a ready-to-send AI review prompt.

Optional semantic evidence exists as bounded support and can also be used by `experience` and `brief`:

```bash
node src/cli.js collect --semantic --compact 8k
ace experience --semantic --json
ace brief --semantic --compact 8k
```

It should remain an evidence layer, not a CodeGraph clone.

## Project Config

ACE reads `ace.config.json` from the inspected project root for `collect`, `experience`, and `brief` evidence.

Example:

```json
{
  "ignore": [".ace/**", "node_modules/**", "dist/**", "build/**", "coverage/**", "*.log"],
  "limits": {
    "maxFiles": 120,
    "maxDiffBytes": 60000,
    "maxOutputBytes": 12000,
    "maxPackBytes": 2000000,
    "timeoutSeconds": 120
  },
  "preferredCommands": [
    {
      "id": "unit-tests",
      "family": "test",
      "command": "npm test",
      "reason": "Default test evidence for AI handoff."
    }
  ],
  "runPolicy": {
    "allow": [],
    "deny": ["git push *", "npm publish *", "rm -rf *"]
  },
  "semantic": {
    "enabled": false
  },
  "prompt": {
    "profile": "ai-coding-handoff",
    "compactBudget": "8k",
    "instructions": [
      "Treat ACE as the current engineering experience handoff.",
      "Do not repeat failed attempts unless new evidence justifies it."
    ],
    "responseFormat": [
      "Current task understanding.",
      "Known failed attempts and do-not-repeat warnings.",
      "Missing evidence.",
      "Next smallest validated step."
    ]
  }
}
```

Config behavior:

- `ignore` filters changed files and untracked files from evidence.
- `limits.maxPackBytes` bounds expandable evidence text before `evidence.json` is written.
- `preferredCommands` appear before package scripts in evidence suggestions.
- `runPolicy.allow` and `runPolicy.deny` optionally gate `ace run` before local command execution. Deny patterns win; when `allow` is non-empty, commands must match an allow pattern.
- `semantic.enabled` can enable bounded semantic evidence by default for `collect`, `experience`, and `brief`; `--no-semantic` disables it for a run.
- `prompt.compactBudget` can set a default compact prompt budget such as `"8k"`.

See [ace.config.example.json](./ace.config.example.json).

## MCP Server

ACE includes an alpha stdio MCP server:

```bash
ace-mcp
```

It exposes:

- `ace_experience`
- `ace_start`
- `ace_note`
- `ace_run`
- `ace_status`
- `ace_brief`

See [docs/integrations.md](./docs/integrations.md).

For Codex desktop, `ace init --codex` generates:

```text
<project>/.codex/config.toml
<project>/.codex/hooks.json
<project>/.codex/hooks/ace-stop-handoff.cjs
```

The generated MCP config starts `ace-mcp` with the project directory as `cwd`, sets `ace_run` and other write-capable tools behind prompt approval by default, and allows read-only handoff tools such as `ace_experience`, `ace_status`, and `ace_brief` automatically.

## Docs

- [Codex integration](./docs/codex.md)
- [Why ACE](./docs/why-ace.md)
- [Experience packet schema](./docs/schema.md)
- [Integrations](./docs/integrations.md)
- [Release checklist](./docs/release-checklist.md)
- [Commercial readiness](./docs/commercial-readiness.md)

## Privacy Model

ACE is local-first. It stores command output, notes, failure signatures, and handoff files under `.ace/`.

Treat `.ace/` as local task evidence unless your team explicitly decides to commit or share it. Command output can contain paths, environment details, logs, customer data, or secrets.

ACE applies best-effort redaction for common patterns such as bearer tokens, `sk-...` keys, GitHub tokens, AWS access keys, secret assignments, private key blocks, and basic-auth URLs. This is not a security guarantee. Inspect `.ace/ledger.json`, `.ace/handoff.md`, and `.ace/runs/**` before sharing, committing, or sending artifacts to another service.

MCP and hooks run as local processes. `ace_run` executes shell commands in the configured project directory with the same local permissions as the MCP client process. Enable ACE MCP only in projects and agent sessions you trust.

For stricter local use, configure `runPolicy` in `ace.config.json` to deny dangerous command patterns or require an allowlist before `ace run` executes anything.

## Roadmap

Phase 1: Engineering Experience Packets

- `init`, `start`, `experience`, `note`, `run`, `status`, and `brief`.
- Durable `.ace/ledger.json` and `.ace/handoff.md`.
- Compact JSON experience packet for AI agents.
- Failure signatures and do-not-repeat extraction.
- Risk signals, missing evidence, and optional bounded semantic support.

Phase 2: Better Experience Compilation

- Cluster similar failures across commands and sessions.
- Detect repeated invalidated paths before an agent repeats them.
- Distinguish failed experiment, abandoned path, confirmed fix, and unresolved blocker.
- Make semantic evidence more useful without becoming a full code graph.

Phase 3: Agent And Team Workflows

- MCP server exposing experience packets, notes, command recording, and handoff tools.
- Claude Code hook examples for pre-command warnings and post-command recording.
- Codex/Cursor/opencode instruction snippets.
- GitHub Action or PR comment summarizing AI attempt evidence.
- Secret redaction policies for shared ledgers.

See [Commercial Readiness](./docs/commercial-readiness.md) for the gaps between this local-first alpha and a sellable team product.

## Open Source And Customization

The useful core should stay local, transparent, and tool-agnostic. Teams can adopt ACE as a small open-source layer first, then customize integrations around their agent stack, CI rules, monorepo layout, security policy, evidence sources, and handoff format.

## Current Status

This directory is intentionally separate from the older local prototype. The product direction is now locked around engineering experience handoff, anti-repeat evidence, and portable AI coding packets. Evidence collection remains a support layer.
