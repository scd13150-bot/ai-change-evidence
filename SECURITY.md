# Security

ACE stores local task evidence under `.ace/`. That evidence can include command output, paths, logs, and notes written by humans or agents.

ACE applies best-effort redaction before writing ledgers, evidence packs, and prompts. Current patterns cover common bearer tokens, `sk-...` keys, GitHub tokens, AWS access keys, secret assignments, private key blocks, and basic-auth URLs. This is a safety net, not a guarantee.

## Before Sharing Evidence

- Inspect `.ace/ledger.json`, `.ace/handoff.md`, and `.ace/runs/**`.
- Remove secrets, tokens, private paths, customer data, and proprietary logs.
- Prefer sharing compact `ace experience --json --no-evidence` output when full evidence is not needed.

## Local Permission Model

ACE does not upload evidence by default, but it can still perform local actions:

- `ace run "command"` executes a shell command in the selected project directory.
- MCP `ace_run` executes a command with the MCP server process permissions.
- MCP `ace_start` and `ace_note` write `.ace/ledger.json`.
- Codex Stop hooks write `.ace/codex-experience.json` and `.ace/handoff.md`.
- Evidence collection reads git diff/file previews and may capture command stdout/stderr.

Only enable ACE MCP and hooks in trusted projects and trusted agent sessions. Treat MCP tools as model-controlled local tools, not as passive documentation.

## Recommended Defaults

- Keep `.ace/` out of source control unless the team explicitly wants shared evidence.
- Use prompt approval for MCP `ace_run`.
- Use `ace experience --json --no-evidence` when you want ledger-only handoff without git/file evidence.
- Review generated `.codex/config.toml` and `.codex/hooks.json` before trusting them in Codex.
- Set `ACE_BIN` to an absolute command path if hook PATH resolution is unclear.

## Reporting Issues

This project is currently alpha. If you find a security issue, open a private report through the repository host if available, or contact the maintainer privately before publishing exploit details.

## Threat Model

ACE is local-first. It does not upload evidence by default. Integrations such as GitHub PR comments, MCP tools, or agent hooks can expose evidence outside the local machine, so teams should review and customize those examples before use.

Out of scope for current alpha:

- Perfect secret detection.
- Sandboxing command execution.
- Preventing a trusted local agent from choosing a harmful command.
- Guaranteeing that third-party MCP clients enforce approval modes consistently.
