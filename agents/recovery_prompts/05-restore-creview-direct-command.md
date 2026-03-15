Restore `/creview` as a direct, usable review command without meta-runner dependencies.

Objectives:
- Rewrite or simplify `.opencode/commands/creview.md` so it can be used directly again.
- Remove dependence on `/run-review`, `run_review`, persisted review artifacts, or cycle-state infrastructure.
- Keep marker-based machine-readable output.

Required behavior:
- Review one explicit target scope directly.
- Inspect repo state, relevant files, and verification evidence.
- Produce structured findings/backlog.
- Emit one final `CYCLE_CREVIEW_RESULT` marker.

Constraints:
- No artifact persistence requirements.
- No plugin interception dependency.
- No phase-closeout side effects.
- Keep the command readable and operationally obvious.

Historical guidance:
- Use the earlier direct `/creview` contract as the baseline.
- Preserve useful later review rigor only when it does not reintroduce coupling.

Verification:
- Run focused tests if present.
- Run build/typecheck.

Output expectations:
- Summarize what dependencies were removed.
- State whether `/creview` is ready for Phase 2 review usage.
