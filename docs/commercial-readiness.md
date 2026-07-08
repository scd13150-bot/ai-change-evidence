# Commercial Readiness

ACE is currently a local-first open-source alpha. It is not yet an enterprise product.

The commercial wedge is credible: teams adopting AI coding agents need a way to preserve failed attempts, validation evidence, and do-not-repeat engineering constraints across sessions and tools. The paid value would come from reducing repeated agent work and turning local handoffs into team-visible engineering evidence.

## Not Enterprise-Ready Yet

Do not sell the current package as a managed team product without adding:

- centrally managed policy controls for `ace_run`, beyond the local `ace.config.json` allow/deny lists;
- approval defaults and policy distribution across agent clients;
- retention rules for `.ace/` ledgers, command output, and generated handoff files;
- organization-level redaction policy and share/export review;
- searchable team failure patterns across repositories and agents;
- audit logs for who recorded notes, ran commands, exported packets, and changed policy;
- dashboard or reporting that shows repeated-failure reduction and validation coverage;
- SSO/SCIM or a private deployment story for larger customers;
- stable cross-client integration tests for Codex, Claude Code, Cursor, and generic MCP clients.

## Sellable Service Path

The near-term commercial path is customization and integration service, not a generic SaaS promise:

- install ACE into an existing AI coding workflow;
- define team policy for command execution and evidence sharing;
- wire ACE into hooks, CI, PR evidence, and internal agent instructions;
- tune failure-signature and evidence heuristics for the customer's stack;
- build a private reporting layer when the local workflow has proven value.

## Proof Needed

Before pitching ACE as a paid product, collect concrete before/after evidence:

- an agent repeats a failed path without ACE;
- the same or next agent avoids it with an ACE packet;
- time or token waste avoided;
- command evidence showing the corrected path;
- team feedback that the handoff changed the next action.

Until that proof exists, position ACE as an engineering experience evidence layer for AI coding agents, with paid customization available for teams that already feel the problem.
