# Release Checklist

Use this before a public alpha release.

- [ ] Fill in real `repository`, `bugs`, and `homepage` metadata in `package.json`.
- [ ] Confirm the npm package name is available or choose the final package name.
- [ ] Run `npm run release:check`.
- [ ] Confirm `package.json` metadata and license.
- [ ] Run `npm run check`.
- [ ] Run `npm test`.
- [ ] Run `npm run smoke:mcp-client`.
- [ ] Run `npm run stress:ledger`.
- [ ] Run `npm run smoke:package-install`.
- [ ] Run `npm pack --dry-run` and inspect included files.
- [ ] Smoke test `node src/cli.js experience --json --no-evidence`.
- [ ] Smoke test that a later matching `ace run` pass resolves an earlier failed command in `validation.unresolvedFailures`.
- [ ] Smoke test `node src/mcp.js` with a stdio MCP client harness.
- [ ] Confirm failed `ace_run` MCP calls return a visible failed-command result.
- [ ] Confirm concurrent ledger writers do not lose entries, corrupt JSON, or leave lock/tmp files.
- [ ] Smoke test `ace init --codex` in a temporary project after `npm link` or package install.
- [ ] Review `.gitignore` and make sure `.ace/` is not committed accidentally.
- [ ] Confirm `ace init` adds or preserves a `.gitignore` entry for `.ace/`.
- [ ] Confirm generated Codex Stop hook writes `.ace/codex-hook-status.json`.
- [ ] Review examples for secrets and private paths.
- [ ] Review the real-project smoke example and keep any private project paths redacted.
- [ ] Review redaction behavior with a fake token in command output.
- [ ] Confirm README first screen explains engineering experience handoff.
- [ ] Confirm `ace start` task-boundary behavior is documented and tested.
- [ ] Confirm commercial/enterprise gaps are stated instead of implied as complete.
- [ ] Review `runPolicy` examples and confirm default config does not unexpectedly block normal validation.
- [ ] Confirm `docs/codex.md` matches current Codex trust, MCP, and hook behavior.
- [ ] Confirm `schemas/experience-packet.schema.json` matches generated packet fields.
- [ ] Tag as alpha and state that schemas may change.

Release should be blocked if:

- MCP docs imply success without a real client or stdio smoke test.
- Concurrent writers can corrupt `.ace/ledger.json` or leave `.ace/ledger.lock`.
- Any doc describes ACE as generic AI memory or git storage.
- `ace_run` permission risk is not visible before setup.
- Generated Codex config requires ACE source files inside the target project.
- `npm run smoke:package-install` cannot prove installed `ace`, `ace-mcp`, generated Codex config, and generated Stop hook all work from a packed tarball.
