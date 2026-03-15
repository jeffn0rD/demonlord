Restore `/implement` as a direct, usable command with minimal moving parts.

Objectives:
- Rewrite or simplify `.opencode/commands/implement.md` so it works as a direct subphase implementation command again.
- Ensure it does not depend on `cycle_runner`, `run_review`, or persisted review artifacts.
- Keep it tasklist-driven and bounded to one subphase.

Required behavior:
- Read tasklist and plan.
- Select explicit subphase when provided, otherwise first incomplete subphase only.
- Execute only that subphase.
- Run relevant verification commands.
- Update task checkboxes in scope.
- Create one local commit using the proposed subphase commit message.
- Emit one final machine-readable marker.

Constraints:
- Keep the contract simple.
- Do not add new orchestration abstractions.
- Avoid changing unrelated commands in this session unless required by the restore.

Historical guidance:
- Use the pre-`run_review`/pre-overcomplication baseline identified in the previous session.
- Prefer the simplest working contract over preserving every later instruction addition.

Verification:
- Run focused validation if command tests exist.
- Run build/typecheck.
- Confirm the command file is internally consistent and still reflects one-subphase-only behavior.

Output expectations:
- Summarize what was simplified.
- List any behavior intentionally dropped.
- Note any follow-up needed before using `/implement` on Phase 2.
