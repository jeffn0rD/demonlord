# Routing Policy: Targeted Context Injection

This document defines deterministic routing behavior for Demonlord so agent sessions load only the context they need.

## Goals

- Route ambiguous work to specification analysis first.
- Improve heuristic routing accuracy using skill-level routing hints.
- Keep implementation sessions focused by injecting narrow, file-level context.

## First-Pass Policy

- If task intent is ambiguous, requirement-heavy, or documentation-seeking, prefer `spec-expert` before implementation routing.
- Ambiguity signals include terms like `unclear`, `ambiguous`, `conflict`, `spec`, `requirements`, `tasklist`, `plan`, and `codename`.
- When policy triggers, orchestrator requests heuristic routing and enforces `spec-expert` to produce a scoped brief before coding.

## Spec Handoff Marker Contract

- A coding implementation session must not start until a spec handoff marker is present and valid.
- Marker file path: `<worktree>/_bmad-output/spec-handoff-<taskID>.md`.
- Required token: `<!-- DEMONLORD_SPEC_HANDOFF_READY -->`.
- Required headings:
  - `## Scope`
  - `## Constraints`
- If marker validation fails, pipeline remains blocked at implementation stage and the spec session is prompted to repair the artifact.
- After marker validation succeeds, orchestrator spawns the follow-up implementation session using the precomputed non-spec target skill.

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
