---
description: Execute implementation [codename] [subphase?]
agent: implementer-standard
---

Execute implementation for codename `$1` using `/agents/$1_Tasklist.md`.

Target selection:
- If `$2` is provided (example: `1.3`), execute that exact subphase only.
- If `$2` is not provided, execute the first not-complete subphase only.

Instructions:
1. Read `/agents/$1_Tasklist.md` and `/agents/$1_Plan.md` first.
2. Select exactly one subphase:
   - `$2` provided -> execute only that subphase.
   - `$2` missing -> execute only the first incomplete subphase.
3. Verify entry criteria and blockers. If blocked, stop and report the blocker.
4. Execute only the selected subphase tasks. Do not execute work from other subphases.
5. Do not call `/cycle`, `/run-review`, or hidden meta-orchestration helpers.
6. Run relevant verification commands for touched areas.
7. Update `/agents/$1_Tasklist.md` task checkboxes for completed tasks in scope.
8. Create one local commit using the subphase proposed commit message. Do not push.
9. End with a normal human-readable summary and the required machine-readable result marker.
10. The machine-readable marker is mandatory even when blocked/failed and must be the last non-whitespace output.

Machine-readable result marker (required at the end):

<!-- CYCLE_IMPLEMENT_RESULT
{"status":"ok|blocked|failed","codename":"$1","subphase":"<n.m>","tasks_completed":["T-x.y.z"],"tests_ran":["<cmd>"],"commit":"<hash-or-unknown>","notes":["..."]}
-->

Rules for marker:
- `status=ok` only when implementation tasks are done, checks are run, and commit succeeded.
- `status=blocked` when dependencies/input prevent completion.
- `status=failed` for execution/test/commit failure.
- Emit exactly one `CYCLE_IMPLEMENT_RESULT` marker.
- Marker JSON must be valid, single-object JSON (no trailing commentary after marker).
- If you cannot finish all narrative sections, still emit the marker with best-known status and notes.
