# Contributing

ACE is early alpha software. Contributions should keep the core narrow:

- Compile engineering experience from AI coding attempts.
- Preserve failed paths, validation evidence, and handoff state.
- Stay local-first and tool-agnostic.
- Treat git as one evidence source, not the product center.

## Development

```bash
npm install
npm run check
npm test
```

## Pull Requests

- Keep changes focused and reversible.
- Add tests for behavior changes.
- Update README or docs when commands, schemas, or workflows change.
- Do not commit `.ace/` task evidence unless the example is intentionally sanitized.

## Design Rule

When in doubt, improve the experience packet:

```text
raw attempts -> normalized failures -> invalidated paths -> missing evidence -> portable handoff
```

Avoid adding platform-specific behavior unless it stays optional and the local CLI remains useful.
