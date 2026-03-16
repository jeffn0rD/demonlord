# Demonlord V1 Reboot Plan

## Executive Summary

This plan outlines the reboot of the `dev` branch into a simpler, installable Demonlord V1. The goal is to prove a bounded-session, manual-first development loop in target repositories. The reboot focuses on simplifying the active path, formalizing command contracts, clarifying agent architecture, and establishing a clear install-source product boundary.

## Recommended Option

**Reset and Simplify**: Execute the subphases defined in `reboot_Tasklist.md` to systematically retire broken paths, formalize V1 commands, define agent roles, and migrate the install source layout.

**Brief Alternatives**
- *Incremental Fixes*: Attempt to patch existing broken paths without a full reset (risk: technical debt accumulation).
- *Full Rewrite*: Rewrite the entire system from scratch (risk: loss of existing functionality and context).

## Phase Breakdown

### PHASE 1: Scope Reset and Active Path Simplification
<!-- PHASE:1 -->
**Goal**: Align all documentation and retire broken commands to establish a clear V1 scope.
**Included Issues**: #123 (Scope alignment), #124 (Retire broken commands)
**Dependencies**: None
**Risks**: Documentation drift if not all files are updated consistently.
**Files to Update**: 
- `README.md`
- `doc/engineering_spec.md`
- `doc/Autonomous_Factory_Summary.md`
- `.opencode/commands/cycle.md`
- `.opencode/commands/run-review.md`
- `.opencode/plugins/orchestrator.ts`
- `.opencode/tests/tools/cycle_runner.test.ts`
- `.opencode/tests/tools/run_review.test.ts`
- `.opencode/tests/integration/orchestration-flow.test.ts`

### PHASE 2: Direct Command Contract Reset
<!-- PHASE:2 -->
**Goal**: Formalize and simplify the core V1 commands (`/plan`, `/implement`, `/creview`, `/repair`, `/phreview`).
**Included Issues**: #125 (Formalize `/plan`), #126 (Simplify `/implement`), #127 (Simplify `/creview`), #128 (Simplify `/repair` and `/phreview`)
**Dependencies**: Phase 1
**Risks**: Breaking existing workflows if simplification is too aggressive.

### PHASE 3: Agent and Session Architecture
<!-- PHASE:3 -->
**Goal**: Define explicit agent roles and bounded-session handoff contracts.
**Included Issues**: #129 (Define agent roles), #130 (Define handoff contract)
**Dependencies**: Phase 2
**Risks**: Over-engineering the agent model if not kept simple.

### PHASE 4: Install-Source Product Boundary
<!-- PHASE:4 -->
**Goal**: Establish a clear boundary between the install source and the target repository.
**Included Issues**: #131 (Define install payload), #132 (Validate sandbox), #133 (Migrate source layout), #134 (Update installer)
**Dependencies**: Phase 3
**Risks**: Path mismatches during migration if references are not updated correctly.

### PHASE 5: Thin Orchestration Follow-On
<!-- PHASE:5 -->
**Goal**: Design a minimal layer for launching commands in fresh sessions.
**Included Issues**: #135 (Design thin session launcher)
**Dependencies**: Phase 4
**Risks**: Reintroducing hidden orchestration if not carefully designed.

## Deferred Issues

1.  **Discord Integration** (#136)
    *   **Reason**: Not required for the V1 bounded-session loop. Can be added later as a thin plugin.
2.  **Parallel Pipeline Execution** (#137)
    *   **Reason**: Long-horizon autonomous operation is deferred until V1 loop is proven stable.
3.  **Shared `/run-review` Dispatcher** (#138)
    *   **Reason**: Optional review abstraction; direct review commands must be stable first.

## Open Questions

1.  What is the exact model tier configuration for `implementer-lite`, `implementer-standard`, and `implementer-pro`?
2.  Should the `hello-app` fixture be updated to match the new install payload contract immediately?
3.  Are there any existing automated tests that rely on the `/cycle` or `/run-review` commands that need to be updated or removed?
