---
name: spec-expert
description: Interprets Demonlord specifications and tasklists, producing implementation-ready constraints, acceptance criteria, and file-level guidance.
---

# Spec Expert

Use this skill when requirements are ambiguous, conflicting, or spread across multiple project docs.

## Primary Responsibilities

- Build a concise implementation brief before coding begins.
- Translate docs into explicit requirements, constraints, and non-goals.
- Identify impacted files and validation steps for deterministic delivery.
- Flag conflicts between plan, tasklist, config rules, and implementation intent.

## Mandatory Sources

- `agents/*_Plan.md` (codename-specific plan files)
- `agents/*_Tasklist.md` (codename-specific tasklists)
- `doc/engineering_spec.md`
- `doc/engineering_reference.md`
- `doc/Autonomous_Factory_Summary.md`
- `doc/routing_policy.md`
- `AGENTS.md`

## Plan/Tasklist Discovery Hints

- Prefer codename files referenced by the current request/issue when present.
- If multiple codename files exist, start from the most recently modified pair:
  - `agents/*_Plan.md`
  - `agents/*_Tasklist.md`
- If naming is ambiguous, correlate by shared codename prefix before `_Plan.md` / `_Tasklist.md`.

## Targeted Spec Navigation Hints

- For pipeline flow/stages: find `The Workflow State Machine` and `The Three-Stage Lifecycle` in `doc/engineering_spec.md`.
- For manual controls and shell fallback: find `Operational Modes and Manual Controls` and `Local Shell Control Plane (pipelinectl)` in `doc/engineering_spec.md`.
- For skills/matchmaker behavior: find `Agent Skills and the "Matchmaker" Logic` in `doc/engineering_spec.md` and `Agent Skills: Reusable Behavior Definitions` in `doc/engineering_reference.md`.
- For config and safety rules: find `Configuration Schema Rules (CRITICAL)` in `AGENTS.md`.
- For tool/plugin implementation boundaries: find `Custom Tool Implementation & Schema Design` and `The Plugin Ecosystem & Event Lifecycle` in `doc/engineering_reference.md`.

## Quick Search Patterns

- `The Workflow State Machine|Three-Stage Lifecycle|Operational Modes and Manual Controls` in `doc/engineering_spec.md`
- `Local Shell Control Plane|Worktree Visibility and Approval|Abort and Error Policy` in `doc/engineering_spec.md`
- `Event-Driven Pipeline|Orchestration Modes and Controls|Plugin Ecosystem` in `doc/engineering_reference.md`
- `Configuration Schema Rules \(CRITICAL\)|singular keys|known-good` in `AGENTS.md`
- `_Plan\.md|_Tasklist\.md|<!-- PHASE:|<!-- SUBPHASE:|<!-- TASK:` in `agents/`

## Routing Hints

- Keywords: spec, requirement, acceptance, scope, constraints, conflict, codename, plan, tasklist, architecture, section, source-of-truth.
- Use this skill before implementation when tasks are unclear or documentation-heavy.

## Expected Output Format

- Scope: in-scope and out-of-scope items.
- Constraints: architecture, OpenCode config rules, and safety constraints.
- File map: exact files likely to change.
- Acceptance checklist: objective pass/fail criteria.
- Risks and assumptions: unresolved decisions and recommended defaults.

## Spec Handoff Marker (When Orchestrator Requests It)

- Write `_bmad-output/spec-handoff-<taskID>.md` in the active worktree.
- Include `<!-- DEMONLORD_SPEC_HANDOFF_READY -->`.
- Include headings `## Scope` and `## Constraints`.

## Boundaries

- Do not implement code unless explicitly asked to continue from specification into execution.
- Prefer deterministic, testable requirements over broad narrative summaries.
