Temporarily simplify `/phreview` so phase closeout is not blocked by missing persisted review artifacts.

Objectives:
- Rewrite or simplify `.opencode/commands/phreview.md` so it can operate without `run_review`-generated artifacts.
- Allow direct inspection of tasklist, codebase state, commit history, and available review evidence.
- Preserve a clear pass/fail closeout decision, but remove hard dependency on the broken artifact pipeline.

Required behavior:
- Review phase scope directly.
- Use persisted artifacts when present, but do not require them.
- If artifacts are missing, fall back to direct evidence gathering.
- Keep phase closeout action explicit and conservative.
- Emit one final `CYCLE_PHREVIEW_RESULT` marker.

Constraints:
- This is a temporary pragmatic recovery path, not the final long-term design.
- Do not reintroduce `run_review` as a hidden fallback.
- Do not let the command silently mark phase complete without evidence.

Verification:
- Run focused tests if present.
- Run build/typecheck.
- Ensure the command text clearly documents the temporary fallback evidence model.

Output expectations:
- State exactly what artifact dependency was removed.
- State the new evidence hierarchy.
- Note any remaining manual operator responsibilities.
