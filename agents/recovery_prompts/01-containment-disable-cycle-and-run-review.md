Disable the broken automation paths first. Work only on containment in this session.

Objectives:
- Disable `/cycle` so it cannot be used accidentally.
- Disable `/run-review` so it cannot be used accidentally.
- Remove or neutralize any orchestrator prehook interception for `/run-review`.
- Make both commands fail loudly with clear operator-facing messaging instead of silently doing partial work.
- Do not attempt to repair `cycle_runner` or `run_review` in this session.

Constraints:
- Preserve all existing broken implementations for later forensic review.
- Do not delete the underlying tool files yet unless absolutely required for disablement.
- Do not modify unrelated command behavior.
- Keep `/implement`, `/creview`, `/repair`, and `/pipeline` usable unless they are directly affected by containment.

Required investigation:
- Inspect `.opencode/commands/cycle.md`
- Inspect `.opencode/commands/run-review.md`
- Inspect `.opencode/plugins/orchestrator.ts`
- Inspect any config/docs references that might keep advertising these commands as active

Implementation target:
- `/cycle` should respond with a deterministic disabled/deprecated message.
- `/run-review` should respond with a deterministic disabled/deprecated message.
- The orchestrator plugin should no longer intercept `/run-review`.
- No code path should automatically route reviews through `executeRunReview`.

Verification:
- Run the smallest relevant tests for changed behavior.
- If no focused tests exist, add or update minimal ones covering disablement.
- Confirm build/typecheck still passes.

Output expectations:
- Summarize exactly what was disabled.
- List every file changed.
- State any remaining paths that could still invoke `cycle_runner` or `run_review`.
