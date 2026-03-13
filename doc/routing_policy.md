# Routing Policy: Targeted Context Injection

This document defines deterministic routing behavior for Demonlord so agent sessions load only the context they need.

## Goals

- Route ambiguous work to specification analysis first.
- Improve heuristic routing accuracy using skill-level routing hints.
- Keep implementation sessions focused by injecting narrow, file-level context.
- Enforce deterministic role/tier routing from explicit tasklist metadata (V1).
- Provide concise, machine-readable spawn and scheduling visibility.

## First-Pass Policy

- If task intent is ambiguous, requirement-heavy, or documentation-seeking, prefer `spec-expert` before implementation routing.
- Ambiguity signals include terms like `unclear`, `ambiguous`, `conflict`, `spec`, `requirements`, `tasklist`, `plan`, and `codename`.
- When policy triggers, orchestrator requests heuristic routing and enforces `spec-expert` to produce a scoped brief before coding.

## V1 Tasklist-Explicit Routing Contract

- Routing source MUST be `orchestration.task_routing.source = "tasklist_explicit"`.
- The orchestrator MUST NOT infer complexity/tier in V1.
- Each runnable task SHOULD define deterministic `EXECUTION` metadata adjacent to the task marker.
- Parser contract: orchestrator scans `<!-- TASK:... -->` markers and consumes the nearest following `<!-- EXECUTION:{...} -->` block for that task reference.
- Task identity source MUST be persisted traversal context (`taskRef`, `tasklistPath`) captured during tasklist selection.
- Session/request title parsing is diagnostic only and MUST NOT be an authoritative metadata lookup source.
- Runtime MUST persist this traversal context in pipeline state and reuse it for metadata resolution, including post-approval and retry flows.
- If traversal context is missing, orchestrator emits a warning and uses deterministic legacy fallback.

Canonical metadata shape:

```md
<!-- TASK:T-3.7.4 -->
<!-- EXECUTION:{"execution":{"role":"implementation","tier":"standard","skill":"backend-specialist","parallel_group":"impl-core","depends_on":["T-3.7.1"]}} -->
- **T-3.7.4**: ...
```

Field contract:

- `execution.role`: `planning` | `implementation` | `review`
- `execution.tier`: `lite` | `standard` | `pro`
- `execution.skill` (optional): explicit skill override
- `execution.parallel_group` (optional): queue affinity token
- `execution.depends_on` (optional): task IDs that MUST complete first

Missing metadata fallback (deterministic):

- Runtime MUST preserve legacy behavior with warning-level event emission.
- Effective defaults: `role=implementation`, `tier=orchestration.task_routing.default_tier`, agent fallback to `minion`.
- Warning and fallback decisions are appended to `_bmad-output/execution-graph.ndjson` with an explicit `reason`.

## Deterministic Tier Selection and Fallback

- Candidate IDs MUST be read from `orchestration.agent_pools[role][tier]` in listed order.
- Runtime MUST select the first ID present in `.opencode/opencode.jsonc.agent`.
- If `.opencode/opencode.jsonc` cannot be parsed/read, runtime MUST fail closed to `task_blocked` with explicit reason logging.
- If unresolved, fallback order MUST be:
  1) same role + `orchestration.task_routing.default_tier`
  2) legacy singleton (`planner` | `minion` | `reviewer`)
  3) explicit block (`task_blocked`) with reason

## Constrained Parallel Dispatch Rules

- Stage model remains `triage -> implementation -> review`.
- Only dependency-ready implementation tasks may run in parallel.
- Capacity limits MUST be enforced by:
  - `orchestration.parallelism.max_parallel_total`
  - `orchestration.parallelism.max_parallel_by_role`
  - `orchestration.parallelism.max_parallel_by_tier`
- FIFO ordering applies within the same stage and `parallel_group`.
- If capacity is unavailable, task MUST stay `queued` (never dropped).
- If dependencies are unresolved, task MUST be `blocked` with explicit reason.

## Execution Graph Event Policy

- Runtime MUST append concise NDJSON events to `_bmad-output/execution-graph.ndjson` when enabled.
- Required event types: `pipeline_started`, `task_queued`, `task_blocked`, `spawn_requested`, `spawn_started`, `spawn_completed`, `task_completed`, `pipeline_completed`.
- Each event MUST include: `seq`, `ts`, `rootSessionID`, `eventType`, `sessionID`, `parentSessionID`, `stage`, `taskRef`, `agentID`, `tier`, `skillID`, `parallelGroup`, `slot`, `status`, and optional `reason`.
- Events MUST be monotonic by `seq` and deduped by `(rootSessionID, taskRef, eventType, status)`.

## Spec Handoff Marker Contract

- A coding implementation session must not start until a spec handoff marker is present and valid.
- Marker file path: `<worktree>/_bmad-output/spec-handoff-<taskID>.md`.
- Required token: `<!-- DEMONLORD_SPEC_HANDOFF_READY -->`.
- Required headings:
  - `## Scope`
  - `## Constraints`
- If marker validation fails, pipeline remains blocked at implementation stage and the spec session is prompted to repair the artifact.
- After marker validation succeeds, orchestrator spawns the follow-up implementation session using the precomputed non-spec target and preserved execution target (`taskRef`, `role`, `tier`, `agentID`, `skill`).

## Plan/Tasklist Discovery

- Codename files use dynamic naming and must be discovered by pattern:
  - `agents/*_Plan.md`
  - `agents/*_Tasklist.md`
- Prefer files explicitly referenced in the active issue/request.
- If multiple codenames exist, start with the most recently modified matching pair.

## Skill Routing Signals

- Skills should include a `## Routing Hints` section with explicit keywords.
- Matchmaker heuristic scoring weights these hints above generic body text.
- Keep hints concise and domain-specific to avoid broad overlap.

## Targeted Spec Anchors

- `doc/engineering_spec.md`
  - `The Workflow State Machine`
  - `Operational Modes and Manual Controls`
  - `Local Shell Control Plane (pipelinectl)`
  - `Worktree Visibility and Approval`
- `doc/engineering_reference.md`
  - `The Event-Driven Pipeline`
  - `Agent Skills: Reusable Behavior Definitions`
  - `The Plugin Ecosystem & Event Lifecycle`
- `AGENTS.md`
  - `Configuration Schema Rules (CRITICAL)`

## Expected Output from Spec-First Pass

- Scope and non-goals.
- Constraints and policy rules.
- File map (exact files to touch).
- Acceptance checklist.
- Risks and assumptions.
