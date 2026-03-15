---
description: Run phase cycle [codename] [phase] [max_repair_rounds?] [dry-run?] [max_subphases?] [no-selfcheck?]
agent: orchestrator
---

Automate one codename phase end-to-end using deterministic subphase looping.

Inputs:
- codename: `$1` (required)
- phase selector: `$2` (required, examples: `1`, `PHASE-1`)
- max repair rounds: `$3` (optional integer, default `2`)
- dry run: `$4` (optional, set to `dry-run` to preview only)
- max subphases: `$5` (optional integer, limit number of pending subphases processed this run)
- self-check toggle: `$6` (optional, set to `no-selfcheck` to disable pre/post non-destructive skills checks)

Execution contract:
1. Call the `cycle_runner` tool exactly once with parsed arguments, including `run_skill_selfcheck`.
2. Do not manually run `/implement`, `/creview`, or `/repair` yourself.
   - Integration note: cycle runner review execution is expected to migrate to the shared `/run-review` path in later orchestration refactors.
3. Return a concise summary of the tool result (status, processed subphases, stop reason if any, state path).
4. Treat `ok=false` or `status=failed` as hard failure; surface `failure_reason` verbatim.
5. Treat `status=partial` as in-progress; surface `remaining_subphases` and suggest resume command.
6. Include `skill_selfcheck` status from the tool result when present.

Parsing rules:
- If `$3` is missing or not a positive integer, use `2`.
- `dry_run=true` only when `$4` equals `dry-run` (case-insensitive).
- If `$4` is a positive integer (and not `dry-run`), treat it as `max_subphases`.
- If `$5` is present and a positive integer, it overrides `$4` for `max_subphases`.
- If max_subphases is missing/invalid, process all pending subphases.
- `run_skill_selfcheck=false` only when `$6` equals `no-selfcheck` (case-insensitive); otherwise default `true`.

Example:
- `/cycle beelzebub PHASE-1 2`
- `/cycle beelzebub 2 3 dry-run`
- `/cycle beelzebub PHASE-1 2 1`
- `/cycle beelzebub PHASE-1 2 dry-run 3`
- `/cycle beelzebub PHASE-1 2 dry-run 3 no-selfcheck`
