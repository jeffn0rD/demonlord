---
description: Run and persist review [review] [p1?] [p2?] [p3?] [p4?] [p5?] [hint?] [phase?] [dry-run?]
agent: reviewer
---

Run a review command through the deterministic review runner and persist artifact output.

Deterministic control-plane routing:
- Primary path: orchestrator plugin intercepts `/run-review` in `command.execute.before` and routes directly through the shared `executeRunReview` executor.
- Interception path does not depend on agent prompt interpretation.
- Direct `/creview`, `/mreview`, and `/phreview` command contracts remain callable and unchanged.
- Fallback path (when plugin interception is unavailable): execute this command contract via one `run_review` tool call.

Hard constraints:
- In fallback mode, first action must be a single `run_review` tool call.
- Do not inspect repository files before calling the tool.
- Do not execute `node`, `bun`, SDK snippets, or ad hoc shell wrappers to run reviews.
- Do not call `/creview`, `/mreview`, or `/phreview` directly from this command.
- If tool execution fails, return that failure verbatim; do not attempt alternate execution paths.

Inputs:
- review command: `$1` (required; examples: `creview`, `mreview`, `phreview`, future `*review` commands)
- command parameter 1: `$2` (optional)
- command parameter 2: `$3` (optional)
- command parameter 3: `$4` (optional)
- command parameter 4: `$5` (optional)
- command parameter 5: `$6` (optional)
- extra hint/instruction text: `$7` (optional; may be blank)
- phase override: `$8` (optional; use `1` or `PHASE-1`, used mainly for module-review scoping)
- dry-run flag: `$9` (optional; set to `dry-run` or `--dry-run`)

Execution contract:
1. Call the `run_review` tool exactly once with parsed arguments.
2. Do not run `/creview`, `/mreview`, or `/phreview` directly in this command.
3. Return a concise human summary with:
   - command executed,
   - marker name + marker status,
   - artifact path + round,
   - inferred/selected phase,
   - and short output excerpt when available.
4. If tool result `ok=false`, treat the run as failed and surface `error` verbatim.

Deterministic tool-call mapping:
- `review` = `$1`
- `parameter_1` = `$2` when non-empty
- `parameter_2` = `$3` when non-empty
- `parameter_3` = `$4` when non-empty
- `parameter_4` = `$5` when non-empty
- `parameter_5` = `$6` when non-empty
- `hint` = `$7` when non-empty
- `phase` = `$8` when non-empty and not a dry-run token
- `dry_run` = `true` when `$9` or `$8` is `dry-run` or `--dry-run` (case-insensitive)

Parsing rules:
- `dry_run=true` when either `$9` or `$8` equals `dry-run` or `--dry-run` (case-insensitive).
- Ignore empty positional parameters.
- Pass `$7` as `hint` exactly as provided when non-empty.
- Pass `$8` as `phase` only when it is non-empty and not a dry-run token.

Examples:
- `/run-review creview beelzebub 1.4`
- `/run-review creview beelzebub 1.4 "focus on shortcuts/hacks"`
- `/run-review mreview .opencode/tools/cycle_runner.ts "TypeError in marker parsing" PHASE-1`
- `/run-review phreview beelzebub 1 "closeout gate" dry-run`
