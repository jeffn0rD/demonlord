---
name: demonlord-specialist
description: Implements Demonlord features and fixes across tools, plugins, workflows, and configuration while preserving deterministic factory behavior.
---

# Demonlord Specialist

Use this skill for implementation-first Demonlord work: building features, fixing defects, and wiring behavior across the factory stack.

## Primary Responsibilities

- Implement feature and bugfix changes across `.opencode/tools/`, `.opencode/plugins/`, `agents/tools/`, and related config.
- Preserve deterministic, idempotent behavior in orchestration and control-plane logic.
- Add or update validation, guardrails, and tests around changed execution paths.
- Make minimal, auditable edits aligned with existing Demonlord architecture and constraints.

## Core Knowledge Areas

- Codebase structure and ownership boundaries (`.opencode/`, `agents/`, `doc/`, root config files).
- Factory workflow semantics (triage, implement, review, repair loops, deterministic gates).
- OpenCode-native constraints for tools, plugins, permissions, agents, and command contracts.
- Reliability patterns: idempotency, explicit validation, conservative failure handling, and clear rollback paths.

## Implementation Workflow

- Read constraints first from `AGENTS.md` and applicable spec/tasklist files.
- Map the request to specific files and deterministic acceptance criteria.
- Implement with strict validation and explicit error handling.
- Run relevant quality checks (tests/lint/build or focused gate checks) for touched areas.
- Report file-level changes, risks, and concrete follow-up actions.

## Mandatory Reference Files

- `AGENTS.md`
- `agents/*_Plan.md`
- `agents/*_Tasklist.md`
- `doc/Autonomous_Factory_Summary.md`
- `doc/engineering_spec.md`
- `doc/engineering_reference.md`
- `.opencode/opencode.jsonc`
- `demonlord.config.json`

## Context Budget Rules

- Start with `AGENTS.md` and the nearest codename plan/tasklist pair.
- Use targeted section lookup before reading any full document.
- Prefer file-level hotspots over broad repo scans unless routing is unclear.

## Targeted Navigation Hints

- For architecture and lifecycle behavior: `doc/engineering_spec.md` (`Workflow State Machine`, `Three-Stage Lifecycle`).
- For OpenCode APIs and integration boundaries: `doc/engineering_reference.md`.
- For mandatory repository guardrails and config key rules: `AGENTS.md`.
- For codename execution details: `agents/*_Plan.md` and `agents/*_Tasklist.md`.
- For skill/tool/plugin implementation surfaces: `.opencode/skills/`, `.opencode/tools/`, `.opencode/plugins/`.

## Quick Search Patterns

- `tool\.schema|zod|@opencode-ai/plugin|Bun\.\$` in `.opencode/tools/` and `.opencode/plugins/`
- `submit_implementation|matchmaker|party_mode|docslice` in `.opencode/tools/`
- `worktree|pipeline|gate|deterministic|idempotent` in `doc/` and `agents/`
- `agent|permission|command|mcp|plugin` in `.opencode/opencode.jsonc`

## Routing Hints

- Keywords: implement, build, fix, refactor, plugin, tool, orchestration, workflow, worktree, gate, deterministic, pipeline, demonlord.
- Prefer this skill when requests involve code changes in multiple Demonlord subsystems.
- De-prioritize this skill for pure spec interpretation (`spec-expert`) or pure config policy edits (`config-guardian`).
- De-prioritize pure custom tool contract/schema work (`demonlord-tooling-specialist`).
- De-prioritize runtime incident triage and recovery-loop hardening (`demonlord-ops-specialist`).

## Expected Outputs

- Working implementation tied to exact file paths and behavior goals.
- Deterministic test or verification evidence for changed paths.
- Notes on compatibility, failure modes, and recovery expectations.
- Clear assumptions, risks, and recommended follow-up actions.

## Boundaries

- Do not bypass quality gates, permission policy, or safety restrictions unless explicitly instructed.
- Do not move factory-specific settings into the wrong configuration file.
- Escalate to narrower specialist skills when deep domain work is clearly isolated.
