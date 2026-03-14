---
name: orchestration-specialist
description: Implements and hardens Demonlord orchestration state machines, pipeline controls, worktree spawning, and command-queue behavior.
---

# Orchestration Specialist

Use this skill for orchestration flow changes, pipeline transition logic, and deterministic control-plane behavior.

## Primary Responsibilities

- Maintain deterministic, idempotent stage transitions (`triage -> implementation -> review -> repair -> review`).
- Implement and harden orchestration controls (`/pipeline`, approval gating, stop/off/on behavior).
- Maintain state snapshot and command queue consistency for shell fallback (`pipelinectl`).
- Ensure worktree spawn/approval behavior is explicit and auditable.

## Primary Files

- `.opencode/plugins/orchestrator.ts`
- `.opencode/plugins/communication.ts`
- `.opencode/tools/matchmaker.ts`
- `.opencode/tools/cycle_runner.ts`
- `.opencode/tools/party_mode.ts`
- `agents/tools/spawn_worktree.sh`
- `agents/tools/pipelinectl.sh`

## Context Budget Rules

- Begin with active orchestration component(s), then follow direct state/queue dependencies only.
- Use doc section landmarks before reading detailed prose.
- Prefer state contract files and tests over full-spec sweeps.

## Targeted Spec Navigation Hints

- `doc/engineering_spec.md`:
  - `The Workflow State Machine`
  - `Operational Modes and Manual Controls`
  - `Local Shell Control Plane (pipelinectl)`
  - `Worktree Visibility and Approval`
  - `Abort and Error Policy`
- `doc/engineering_reference.md`:
  - `The Event-Driven Pipeline`
  - `Orchestration Modes and Controls`
  - `The Plugin Ecosystem & Event Lifecycle`
  - `Model Context Protocol (MCP) & The Dual-Mode Matchmaker`
- `agents/*_Tasklist.md`: Subphases 3.x and orchestration-specific tasks.

## Routing Hints

- Keywords: orchestrator, pipeline, transition, idle, session.error, noReply, approval, worktree, spawn, queue, snapshot, pipelinectl, dedupe, state machine.
- De-prioritize Discord transport/authz specifics (`discord-specialist`).
- De-prioritize pure config policy edits (`config-guardian`).

## Boundaries

- Do not loosen deterministic quality or approval gates without explicit instruction.
- Keep changes backward-compatible with manual mode unless migration is part of scope.
