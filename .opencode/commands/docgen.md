---
description: Generate Plan and Tasklist markdown files
agent: build
---

You are a technical writer and delivery lead. Generate two markdown documents with deterministic anchors for agentic execution.

TARGET PATHS (IMPORTANT)
- Write these files as content blocks:
  1) /agents/$1_Plan.md
  2) /agents/$1_Tasklist.md
Note: /agents is NOT tracked by git; these are working documents for agents.

DETERMINISTIC MARKERS
- Every Phase header must include a marker line:
  <!-- PHASE:1 -->
- Every Subphase header must include:
  <!-- SUBPHASE:1.2 -->
- Every task line must include:
  <!-- TASK:T-1.2.3 -->

CROSS-REFERENCES
- Tasklist must reference the relevant Plan phase/subphase markers.
- Keep GitHub issue references intact (#123).

CONTENT REQUIREMENTS
/agents/$1_Plan.md
- Executive summary
- Recommended option + brief alternatives
- Phase breakdown (goals, included issues, dependencies, risks)
- Deferred issues (with reasons)
- Open questions

/agents/$1_Tasklist.md
- “How to execute” section: run /implement $1 to start.
- Phase/subphase breakdown with entry/exit criteria
- Subphase-level PR title + commit message
- Task list (atomic)

OUTPUT
- Provide the complete markdown content for both files.
