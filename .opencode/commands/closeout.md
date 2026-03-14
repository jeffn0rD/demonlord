---
description: Perform repo and agent-workspace cleanup and produce a closeout note
agent: minion
---

You are a release/closeout assistant. We have completed implementation and merged/pushed the work for the current phase in $1_Tasklist.md.

Goal: Perform repo and agent-workspace cleanup and produce a closeout note.

CONSTRAINTS
- Do not delete anything tracked by git unless explicitly instructed.
- /agents is untracked and may contain working documents.
- Use deterministic, auditable steps. Prefer listing actions over improvising.

CHECKS
1) Confirm working tree is clean (no uncommitted tracked changes).
2) Confirm tests/build checks appropriate to the repo have been run (state what was run or ask what to run).
3) Verify the subphase’s GitHub issues are updated via commit message semantics (Fixes/Refs).

/AGENTS FOLDER MANAGEMENT
4) Discover the current Phase/Subphase numbers (X and Y) that were just completed.
5) Move the latest /agents/$1_Plan.md and /agents/$1_Tasklist.md to:
   /agents/completed/{YYYY-MM-DD}__phase-{X}__subphase-{Y}/
6) In that folder, create Closeout.md including:
   - what was delivered
   - PR link (if provided) or commit hash (if available)
   - issues fixed/referenced
   - follow-ups discovered

OPTIONAL TOOLS
7) If any helper scripts were created during the subphase, place them in:
   /agents/tools/
   and add a short README at /agents/tools/README.md describing purpose and usage.

8) run `/dev-tools/archive_phase.py --$2` (in repo root venv)
9) run `/dev-tools/sync_changelog.py` (in repo root venv)

OUTPUT
- A checklist of completed actions.
- The exact file moves/paths you performed (or would perform).
- The contents of Closeout.md.
Stop after closeout; do not start new work.
