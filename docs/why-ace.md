# Why ACE

AI coding agents often fail in ways that normal project context does not preserve:

- A command failed, but the next session retries it without changed inputs.
- An approach was abandoned, but the reason stays in chat history.
- Validation evidence exists, but it is not attached to the next handoff.
- The next agent sees the repository but not the engineering experience that led to the current state.

ACE does not try to replace agent memory, git history, CodeGraph tools, or test frameworks. It compiles the experience of an AI coding attempt into a portable packet.

## What ACE Adds

- Normalized failure signatures across local paths and line numbers.
- Do-not-repeat constraints from notes and repeated failures.
- Validation state from commands run through ACE.
- Missing-evidence reasoning before strong readiness claims.
- Optional bounded semantic impact facts.
- Human-readable and machine-readable handoff formats.

## What ACE Does Not Do

- It does not decide whether a change is correct.
- It does not replace tests or review.
- It does not require a SaaS backend.
- It does not need to own the whole agent workflow.

ACE is useful when the next agent needs to know not just what the code looks like, but what has already been tried and disproven.
