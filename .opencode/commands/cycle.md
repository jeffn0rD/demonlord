---
description: Run phase cycle [codename] [phase] [max_repair_rounds?] [dry-run?]
agent: orchestrator
---

Automate one codename phase end-to-end using deterministic subphase looping.

Inputs:
- codename: `$1` (required)
- phase selector: `$2` (required, examples: `1`, `PHASE-1`)
- max repair rounds: `$3` (optional integer, default `2`)
- dry run: `$4` (optional, set to `dry-run` to preview only)

Execution contract:
1. Call the `cycle_runner` tool exactly once with parsed arguments.
2. Do not manually run `/implement`, `/creview`, or `/repair` yourself.
3. Return a concise summary of the tool result (status, processed subphases, stop reason if any, state path).

Parsing rules:
- If `$3` is missing or not a positive integer, use `2`.
- `dry_run=true` only when `$4` equals `dry-run` (case-insensitive).

Example:
- `/cycle beelzebub PHASE-1 2`
- `/cycle beelzebub 2 3 dry-run`
