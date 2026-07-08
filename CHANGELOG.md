# Changelog

## 0.1.1

- Fix: bin scripts restored — `ace` and `ace-mcp` commands now install correctly
- Added: `ace doctor`, `ace export`, `ace prune` CLI commands
- Added: `repository`, `bugs`, `homepage` metadata to package.json
- Fixed: `evidenceStatus` schema field changed from bare string to enum
- Internal: merged duplicate `runProcess` implementation, removed dead code

## 0.1.0

- Initial alpha release
- CLI: `init`, `start`, `note`, `run`, `status`, `experience`, `brief`, `collect`
- MCP server: `ace_experience`, `ace_start`, `ace_note`, `ace_run`, `ace_status`, `ace_brief`
- Failure signature normalization, do-not-repeat extraction, secret redaction
- Compact token-budget-aware prompt generation
- Project-local Codex desktop integration (`ace init --codex`)
- JSON Schema validation for experience packets
- 54 tests, concurrent ledger stress testing, package-install smoke
