---
description: Run non-destructive skill-system self-checks [quick|full]
agent: orchestrator
---

Run deterministic, non-destructive checks for skill routing/docslice/index hygiene.

Inputs:
- mode: `$1` (optional, default `quick`, allowed: `quick`, `full`)

Execution contract:
1. If `$1` is missing or invalid, use `quick`.
2. In `quick` mode, run from repository root:
   - `npm --prefix .opencode run skills:test`
3. In `full` mode, run from repository root:
   - `npm --prefix .opencode run skills:test`
   - `npm --prefix .opencode run test:tools`
4. Do not modify files during this command.
5. Return pass/fail summary and list failing tests/commands verbatim when failures occur.

Notes:
- `skills:test` validates index freshness and runs docslice unit tests only.
- This command is safe for phase-cycle smoke checks because it is read-only.

Examples:
- `/skills-selfcheck`
- `/skills-selfcheck quick`
- `/skills-selfcheck full`
