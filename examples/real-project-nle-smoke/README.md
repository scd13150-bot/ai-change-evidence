# Real Project NLE Smoke

This is a sanitized smoke transcript from a real JavaScript/React NLE-style project.

No private source, command output, or absolute local path is copied into this example. The useful point is the workflow shape: ACE can keep the engineering handoff ledger outside the target project while recording a real external validation command.

## Why This Case Exists

The target project had a long-running `npm run check` path that exceeded 120 seconds during manual validation. A useful agent handoff should not hide that. It should preserve the lesson and move to the smallest bounded evidence command first.

## Commands

```bash
ace start "Real NLE project handoff smoke" --reset --workdir <temp-ledger-dir>
ace note "Do not repeat npm run check as the first NLE validation; it exceeded 120s in the real project smoke. Use the bounded unit test command first, then return to check with a narrower timeout or diagnostics." --workdir <temp-ledger-dir>
ace run "npm --prefix <external-nle-project> test" --timeout 30 --workdir <temp-ledger-dir>
ace experience --json --no-evidence --workdir <temp-ledger-dir>
ace brief --compact 8k --print --no-evidence --workdir <temp-ledger-dir>
```

## Observed Result

```json
{
  "schema": "ace.experience-packet.v1",
  "experienceSummary": {
    "status": "validated-so-far",
    "entries": 3,
    "failedCommands": 0,
    "passedCommands": 1,
    "doNotRepeatItems": 1,
    "nextActionBias": "avoid invalidated approaches before editing"
  },
  "validation": {
    "state": "passed",
    "commands": 1,
    "passed": 1,
    "failed": 0,
    "unresolvedFailures": 0
  },
  "externalCommand": {
    "command": "npm --prefix <external-nle-project> test",
    "exitCode": 0,
    "durationMs": 1156,
    "observedTestCount": 25
  },
  "doNotRepeat": [
    "Do not repeat npm run check as the first NLE validation; it exceeded 120s in the real project smoke. Use the bounded unit test command first, then return to check with a narrower timeout or diagnostics."
  ]
}
```

## Interpretation

ACE did not solve the target project's long-running check. It transferred the engineering experience:

- the next agent sees that `npm run check` was a poor first move in this environment;
- the next agent sees a real passing unit-test command before editing;
- the target project was not mutated because the ledger lived in `<temp-ledger-dir>`;
- the sample remains safe to publish because paths and source content are redacted.
