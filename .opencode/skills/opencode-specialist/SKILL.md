---
name: opencode-specialist
description: Implements and hardens OpenCode command/tool workflows, session automation loops, and deterministic command contracts.
---

# OpenCode Specialist

Use this skill for OpenCode-native command and tooling work, especially when implementing deterministic workflow automation.

## Primary Responsibilities

- Build and maintain command definitions in `.opencode/commands/`.
- Integrate command behavior with deterministic tool interfaces in `.opencode/tools/`.
- Harden machine-readable command contracts for automation (`/implement`, `/creview`, `/mreview`, `/repair`, `/cycle`).
- Preserve session isolation and low-context orchestration patterns for long-running loops.

## Primary Files

- `.opencode/commands/*.md`
- `.opencode/tools/*.ts`
- `.opencode/tests/tools/*.test.ts`
- `.opencode/plugins/orchestrator.ts` (only when command/tool changes require integration)

## Context Budget Rules

- Start from the command contract file, then trace only directly connected tool handlers.
- Read schema and output markers before reading broader docs.
- Use referenced spec sections selectively; avoid full-document ingestion.

## Targeted Spec Navigation Hints

- `doc/engineering_reference.md`:
  - `Custom Tool Implementation & Schema Design`
  - `The Plugin Ecosystem & Event Lifecycle`
  - `Governance: Permissions, Configuration, and Security`
- `doc/engineering_spec.md`:
  - `The Workflow State Machine`
  - `Operational Modes and Manual Controls`
  - `Abort and Error Policy`
- `AGENTS.md`:
  - `OpenCode Specific Constraints`
  - `Configuration Schema Rules (CRITICAL)`

## Routing Hints

- Keywords: opencode, command, slash command, tool schema, deterministic output, cycle loop, implement, creview, mreview, repair, session automation, machine-readable marker, noReply.
- De-prioritize isolated custom tool implementation with no command-contract impact (`demonlord-tooling-specialist`).
- De-prioritize runtime recovery/runbook triage (`demonlord-ops-specialist`).

## Boundaries

- Prefer deterministic state/artifact-driven flow over prompt-only control.
- Do not introduce non-auditable or stochastic automation behavior.
- Keep changes backward-compatible with existing command usage unless migration is explicitly requested.
