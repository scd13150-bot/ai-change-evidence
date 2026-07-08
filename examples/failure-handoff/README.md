# Failure Handoff Example

This example shows the intended ACE story:

1. An agent starts with an objective.
2. It tries a validation command and records a failure signature.
3. It records a do-not-repeat note for an abandoned path.
4. The next agent reads an experience packet instead of restarting from a blank slate.

Files:

- [experience.json](./experience.json): machine-readable handoff packet.
- [handoff.md](./handoff.md): human-readable brief.

The key signal is that the next agent sees both the failed command and the invalidated approach before changing files.
