---
name: demonlord-ops-specialist
description: Troubleshoots and hardens Demonlord operational workflows, including pipeline control, worktree execution, quality gates, and recovery behavior.
---

# Demonlord Ops Specialist

Use this skill for narrow operational work: diagnosing stuck pipelines, gate failures, worktree issues, and command/control behavior.

## Primary Responsibilities

- Diagnose failures across triage/implement/review/repair lifecycle transitions.
- Stabilize worktree and command-queue behavior with deterministic recovery logic.
- Investigate and improve quality gate behavior (lint/test/build checks, repair loops).
- Improve operational visibility with clear logs, status signals, and failure categorization.

## Primary Files

- `.opencode/commands/implement.md`
- `.opencode/tools/submit_implementation.ts`
- `.opencode/tools/matchmaker.ts`
- `.opencode/tools/party_mode.ts`
- `agents/tools/`
- `doc/engineering_spec.md`
- `doc/engineering_reference.md`
- `AGENTS.md`

## Targeted Navigation Hints

- For lifecycle stages and state behavior: `doc/engineering_spec.md` (`Workflow State Machine`, `Three-Stage Lifecycle`).
- For manual controls and shell fallback: `doc/engineering_spec.md` (`Operational Modes and Manual Controls`, `Local Shell Control Plane`).
- For permissions and policy constraints: `AGENTS.md` and `doc/engineering_reference.md` governance sections.

## Quick Search Patterns

- `dry_run|resume|max_repair_rounds|failure|retry|abort` in `.opencode/tools/`
- `worktree|spawn|queue|session|status|halt|continue` in `.opencode/tools/` and `agents/tools/`
- `gate|lint|test|build|deterministic|idempotent` in `.opencode/tools/` and `doc/`

## Context Budget Rules

- Begin with the failing stage/tool path and read only directly related files.
- Use grep-first navigation, then read minimal sections needed for root-cause confirmation.
- Avoid broad full-document reads unless failure origin is unknown.

## Routing Hints

- Keywords: ops, operational, troubleshoot, broken, stuck, pipeline, gate, worktree, queue, retry, repair, recovery, runbook.
- Prefer this skill for runtime behavior and reliability hardening, not feature product work.
- De-prioritize pure custom tool feature implementation (`demonlord-tooling-specialist`).

## Expected Outputs

- Root-cause hypothesis tied to specific files and execution stages.
- Minimal deterministic fix with explicit failure-path handling.
- Verification checklist proving recovery and non-regression behavior.
- Short runbook-style notes for future operators.

## Boundaries

- Avoid broad architecture redesign unless required by the fix.
- Defer pure product feature implementation to `demonlord-specialist` or domain specialists.
- Keep policy restrictions and non-destructive defaults intact unless explicitly changed.
