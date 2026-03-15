Create a forensic archive of the current broken cycle/review system outside `.opencode`.

Objectives:
- Create or use a top-level forensic archive area outside `.opencode`.
- Copy the current versions of all relevant files into that archive.
- Preserve a manifest describing what was archived and why.
- Preserve representative broken state/artifact files if they exist.

Files to archive at minimum:
- `.opencode/tools/cycle_runner.ts`
- `.opencode/tools/run_review.ts`
- `.opencode/plugins/orchestrator.ts`
- `.opencode/commands/cycle.md`
- `.opencode/commands/run-review.md`
- `.opencode/commands/phreview.md`
- `.opencode/commands/implement.md`
- `.opencode/commands/creview.md`
- `.opencode/tests/tools/cycle_runner.test.ts`
- `.opencode/tests/tools/run_review.test.ts`
- `.opencode/tests/integration/orchestration-flow.test.ts`

Artifacts/state to preserve when present:
- `_bmad-output/cycle-state/beelzebub-phase-1.json`
- `_bmad-output/cycle-state/reviews/`
- `_bmad-output/orchestration-state.json`
- other closely related orchestration/cycle evidence files you find relevant

Manifest requirements:
- original path
- archived path
- current commit SHA
- reason for archival
- notes on suspected failure role

Constraints:
- This is archival only. Do not fix logic in this session.
- Do not delete source files after copying.

Verification:
- Confirm all archive targets exist.
- Confirm manifest exists and is readable.

Output expectations:
- List archive directory used.
- List files and artifacts copied.
- Note any expected items that were missing.
