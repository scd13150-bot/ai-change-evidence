# Codex Desktop Smoke

Use this example to verify ACE in the Codex desktop app, not just the CLI.

## Setup

1. Install or link ACE so `ace` and `ace-mcp` are on `PATH`.
2. In the target project, run `ace init --codex`.
3. Open the project in Codex desktop.
4. Trust the project config when prompted.
5. Trust project hooks with `/hooks` if you want to test the Stop hook.
6. Start a new thread after the trust step.

## Prompt

```text
Use the ACE MCP server if available. Call ace_start with objective "Desktop MCP smoke", then call ace_note with "Do not repeat the fake failing path; this is a smoke test.", then call ace_experience with noEvidence true and summarize the schema and do-not-repeat item.
```

## Expected

- Codex uses MCP tools named `ace_start`, `ace_note`, and `ace_experience`.
- The result schema is `ace.experience-packet.v1`.
- The do-not-repeat note appears in the experience packet.

## Stop Hook Smoke

After `/hooks` trust, end the thread. The project hook should write:

```text
.ace/codex-experience.json
.ace/handoff.md
```

The hook is intentionally non-blocking. Evidence collection warnings should not prevent Codex from stopping.

If Codex cannot find `ace` from the hook, set `ACE_BIN` to an absolute `ace` command path before launching Codex.
