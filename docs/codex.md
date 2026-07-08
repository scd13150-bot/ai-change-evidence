# Codex Desktop Integration

ACE supports Codex desktop through project-local MCP and Stop-hook configuration.

References used for this integration:

- [Codex MCP](https://developers.openai.com/codex/mcp)
- [Codex hooks](https://developers.openai.com/codex/hooks)

## Recommended Setup

Install ACE so `ace` and `ace-mcp` are on `PATH`:

```bash
npm install -g ai-change-evidence
```

For local development from this checkout:

```bash
npm install
npm link
```

Then initialize the target project:

```bash
ace init --codex
```

This writes:

```text
<project>/.codex/config.toml
<project>/.codex/hooks.json
<project>/.codex/hooks/ace-stop-handoff.cjs
```

The generated MCP config uses:

```toml
[mcp_servers.ace]
command = "ace-mcp"
cwd = "<absolute-project-path>"
startup_timeout_sec = 10
tool_timeout_sec = 60
default_tools_approval_mode = "prompt"
```

Read-only handoff tools are set to `approval_mode = "auto"`:

- `ace_experience`
- `ace_status`
- `ace_brief`

Write-capable or command-running tools stay behind prompt approval by default:

- `ace_start` writes `.ace/ledger.json`
- `ace_note` writes `.ace/ledger.json`
- `ace_run` executes a local shell command and records output

## Desktop Loading Model

Codex project config and hooks are trust-gated. After adding `.codex/config.toml` or hooks:

1. Trust the project config in Codex.
2. Trust hooks with `/hooks` if you want the Stop hook.
3. Start a fresh desktop thread or reopen the project.

Do not treat an already-open thread as a hot-reload test. Its visible tool list may be fixed for that thread.

## MCP Tools

The ACE server exposes:

- `ace_experience`
- `ace_start`
- `ace_note`
- `ace_run`
- `ace_status`
- `ace_brief`

The MCP server also returns server instructions during initialization so the agent knows to read experience before editing, record abandoned paths, and run validation through ACE when appropriate.

Local stdio smoke test:

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
$msg = "Content-Length: $([Text.Encoding]::UTF8.GetByteCount($body))`r`n`r`n$body"
$msg | ace-mcp
```

From this checkout without `npm link`:

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
$msg = "Content-Length: $([Text.Encoding]::UTF8.GetByteCount($body))`r`n`r`n$body"
$msg | node src/mcp.js
```

## Hook

The generated Stop hook runs:

```bash
node .codex/hooks/ace-stop-handoff.cjs
```

It calls `ace experience --json` and `ace brief --compact 8k`, then writes:

```text
.ace/codex-experience.json
.ace/codex-hook-status.json
.ace/handoff.md
```

The hook intentionally exits `0` even when ACE reports a warning, so it does not block Codex from stopping. Inspect `.ace/codex-hook-status.json` when the handoff files are missing or stale.

If Codex cannot find `ace`, set `ACE_BIN` to an absolute command path before launching Codex or edit the generated hook:

```powershell
$env:ACE_BIN = "C:\Users\you\AppData\Roaming\npm\ace.cmd"
```

## Minimal Desktop Test

After trusting project config in Codex desktop, open a new thread in the project and ask:

```text
Use the ACE MCP server if available. Call ace_start with objective "Desktop MCP smoke", then call ace_note with "Do not repeat the fake failing path; this is a smoke test.", then call ace_experience with noEvidence true and summarize the schema and do-not-repeat item.
```

Expected result:

- Codex desktop chooses ACE MCP tools, not shell commands.
- The returned packet has `schema: "ace.experience-packet.v1"`.
- The packet includes the do-not-repeat note.

If the desktop thread cannot see `ace_start` or `ace_experience`, start a fresh thread after trusting project config. If it still cannot see them, check that `ace-mcp` is on `PATH`, inspect the generated `cwd`, and confirm managed policy does not disable custom MCP servers.

## Permission Risk

ACE MCP is local-first, but it is still a local tool server:

- `ace_experience`, `ace_status`, and `ace_brief` read local `.ace` state and may inspect git evidence.
- `ace_start` and `ace_note` write `.ace/ledger.json`.
- `ace_run` executes shell commands in the configured `cwd` with the same local permissions as the Codex/MCP client process.
- The Stop hook writes `.ace/codex-experience.json`, `.ace/codex-hook-status.json`, and `.ace/handoff.md`.

If a project needs a narrower command surface, configure `runPolicy.allow` and/or `runPolicy.deny` in `ace.config.json`; ACE checks that policy before `ace_run` executes the command. Codex tool approval is still recommended because local policy is not a substitute for user intent.

Enable ACE MCP only in trusted projects and trusted agent sessions. Redaction is best-effort; inspect `.ace/` before sharing or committing artifacts.

## Repository Development Config

This repository also includes development config:

- [.codex/config.toml](../.codex/config.toml) starts `node src/mcp.js`.
- [.codex/hooks.json](../.codex/hooks.json) registers the Stop hook.
- [.codex/hooks/ace-stop-handoff.js](../.codex/hooks/ace-stop-handoff.js) uses this checkout's `src/cli.js`.

That is for working on ACE itself. User projects should prefer `ace init --codex`.
