# Experience Packet Schema

Current schema:

```text
ace.experience-packet.v1
```

JSON Schema artifact:

```text
schemas/experience-packet.schema.json
```

Generate it with:

```bash
ace experience --json
```

Use `--no-evidence` when you only want ledger-derived experience and do not want git/evidence collection.

## Top-Level Fields

- `schema`: packet schema id.
- `role`: `engineering-experience-handoff`.
- `projectDir`: inspected project directory.
- `objective`: current task objective.
- `experienceSummary`: compact status and next-action bias.
- `state`: counts for entries, commands, failures, and repeated patterns.
- `recentTimeline`: recent objective, notes, and commands.
- `failedCommands`: recent failed commands with normalized signatures.
- `unresolvedFailedCommands`: failed commands not yet followed by a later successful run of the same normalized command.
- `validation`: validation state compiled from `ace run`.
- `invalidatedPaths`: do-not-repeat notes and repeated failure patterns.
- `doNotRepeat`: text warnings the next agent should honor.
- `evidence`: compact changed-file/risk evidence when available.
- `missingEvidence`: evidence gaps to close before strong claims.
- `suggestedNextEvidence`: commands or checks likely to produce useful proof.
- `semanticImpact`: optional bounded semantic impact summary.
- `agentInstructions`: operational hints for the next agent.

## Status Values

`experienceSummary.status` can be:

- `has-failed-validation`
- `missing-critical-evidence`
- `ledger-only`
- `validated-so-far`
- `needs-validation`

`validation.state` can be:

- `failed`
- `passed`
- `not-run`

## Compatibility

`ace context --json` is kept as an alias for `ace experience --json`, but new integrations should use `experience`.

## Stability

The schema is alpha. Additive fields may appear in patch/minor releases. Consumers should rely on:

- `schema`
- `role`
- `experienceSummary`
- `validation`
- `invalidatedPaths`
- `doNotRepeat`
- `evidence.status`
- `missingEvidence`
- `suggestedNextEvidence`
- `semanticImpact.status`

Top-level, summary, state, and validation fields are intentionally strict so clients can detect contract drift. Treat nested `evidence`, `semanticImpact`, and item-level additional fields as forward-compatible alpha metadata.
