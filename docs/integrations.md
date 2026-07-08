# Integrations

ACE should stay useful as a local CLI first. Integrations should be thin adapters around the same experience packet.

## Codex / AGENTS.md

Run:

```bash
ace init
```

This writes `AGENTS.md` guidance telling agents to read `ace experience --json`, run validations through `ace run`, and write a handoff with `ace brief`.

For project-local Codex MCP and hook setup:

```bash
ace init --codex
```

See [Codex Integration](./codex.md).

## MCP

ACE includes an alpha stdio MCP server:

```bash
ace-mcp
```

Local development:

```bash
node src/mcp.js
```

Repository smoke test:

```bash
npm run smoke:mcp-client
```

This starts `node src/mcp.js` as a stdio server and drives it like a third-party MCP client: initialize, list tools, call `ace_start`, `ace_note`, `ace_run`, `ace_experience`, verify failed-command behavior, verify unknown-tool errors, and check that a fake token is redacted in the written ledger.

Exposed tools:

- `ace_experience`
- `ace_start`
- `ace_note`
- `ace_run`
- `ace_status`
- `ace_brief`

The server intentionally uses the same local ledger and packet compiler as the CLI.

Minimal MCP config for clients that support stdio servers:

```toml
[mcp_servers.ace]
command = "ace-mcp"
cwd = "/absolute/path/to/project"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

Use prompt approval for `ace_run` in clients that support tool-level approval. `ace_run` executes a local shell command; `ace_start` and `ace_note` write `.ace/ledger.json`. A failed local command is returned as a tool error result with `status: "failed-command"` while still recording the ledger entry.

When using from a checkout instead of an installed package:

```toml
[mcp_servers.ace]
command = "node"
args = ["src/mcp.js"]
cwd = "/absolute/path/to/ai-change-evidence"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

For a real target project, pass `workdir` in tool arguments or install/link ACE and prefer `ace init --codex` so `cwd` is the target project.

## Claude Code Hooks

See [examples/claude-code-hooks/settings.example.json](../examples/claude-code-hooks/settings.example.json).

The example shows:

- recording a handoff at stop time;
- encouraging agents to use `ace run` for validations;
- keeping evidence local by default.

Treat the hook file as a starting point. Review command paths and privacy rules before using it in a real repository.

## GitHub PR Evidence

See [.github/workflows/ace-pr-evidence.yml](../.github/workflows/ace-pr-evidence.yml).

The workflow builds an ACE handoff brief for a pull request and comments a compact summary when the PR comes from the same repository. Fork PR comments are skipped by default to avoid exposing write tokens to untrusted code.
