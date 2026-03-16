---
description: Plan bounded V1 phases and tasklist updates [codename]
agent: planner
---

Create or update a bounded implementation plan for codename `$1`.

Inputs:
- codename: `$1` (required)
- plan path: `agents/$1_Plan.md`
- tasklist path: `agents/$1_Tasklist.md`

Execution contract:
1. Read the current `agents/$1_Plan.md` and `agents/$1_Tasklist.md` if they exist.
2. Produce planning output only. Do not implement code, edit source files, or run build/test commands.
3. Keep scope bounded to phase/subphase planning.
4. Ensure output can be executed one subphase at a time.
5. If artifacts exist, update them in-place conceptually (what to add/remove/change); if missing, define them from scratch.
6. Include explicit dependency ordering and deferred items.

Required handoff sections in output:
A) Scope and assumptions
B) Phase map (`PHASE:n` with goals, dependencies, risks)
C) Subphase map (`SUBPHASE:n.m` with entry/exit criteria)
D) Tasklist contract (`TASK:T-x.y.z` formatting and completion checkbox format)
E) Deferred items
F) Open questions/blockers

Required final marker (last non-whitespace output):

<!-- CYCLE_PLAN_RESULT
{"status":"ok|blocked|failed","codename":"$1","plan_path":"agents/$1_Plan.md","tasklist_path":"agents/$1_Tasklist.md","artifacts_updated":["agents/$1_Plan.md","agents/$1_Tasklist.md"],"notes":["..."]}
-->

Marker rules:
- `status=ok` when a bounded phase/subphase plan and tasklist contract are produced.
- `status=blocked` when required inputs are missing/ambiguous.
- `status=failed` when planning could not be completed.
- Emit exactly one `CYCLE_PLAN_RESULT` marker.
