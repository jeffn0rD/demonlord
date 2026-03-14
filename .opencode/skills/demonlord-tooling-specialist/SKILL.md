---
name: demonlord-tooling-specialist
description: Implements and hardens Demonlord custom OpenCode tools with strict schemas, deterministic contracts, and test-backed reliability.
---

# Demonlord Tooling Specialist

Use this skill for narrow implementation work in `.opencode/tools/`, especially schema, contract, and deterministic execution behavior.

## Primary Responsibilities

- Implement and refactor custom tools in `.opencode/tools/*.ts`.
- Enforce strict `tool.schema` validation and deterministic output contracts.
- Define explicit error surfaces, input guards, and idempotent control flow.
- Add or update focused tool tests in `.opencode/tests/tools/*.test.ts`.

## Primary Files

- `.opencode/tools/*.ts`
- `.opencode/tests/tools/*.test.ts`
- `.opencode/commands/*.md` (when tool contract changes affect command usage)
- `doc/engineering_reference.md`
- `AGENTS.md`

## Targeted Navigation Hints

- For tool schema and implementation rules: `doc/engineering_reference.md` (`Custom Tool Implementation & Schema Design`).
- For safety and config constraints: `AGENTS.md` (`OpenCode Specific Constraints`, `Configuration Schema Rules (CRITICAL)`).
- For routing/contract implications: `.opencode/tools/matchmaker.ts` and relevant command docs.

## Quick Search Patterns

- `tool\.schema|zod|@opencode-ai/plugin` in `.opencode/tools/*.ts`
- `return JSON\.stringify|deterministic|idempotent|validation|error` in `.opencode/tools/*.ts`
- `matchmaker|cycle_runner|submit_implementation|party_mode` in `.opencode/tools/*.ts`

## Context Budget Rules

- Start with the single target tool file and its test file.
- Read command docs only when output or arguments cross command boundaries.
- Use section landmarks for docs; avoid full-document reads by default.

## Routing Hints

- Keywords: tool, tooling, schema, zod, command contract, deterministic output, validation, custom tool, opencode tool, idempotent, args parsing.
- Prefer this skill for isolated tool code changes not requiring broad orchestration redesign.
- De-prioritize runtime incident triage (`demonlord-ops-specialist`).
- De-prioritize broad multi-subsystem feature work (`demonlord-specialist`).

## Expected Outputs

- Minimal tool implementation diff with explicit schema and failure-path handling.
- Updated tool tests proving deterministic behavior and non-regression.
- Notes on contract compatibility and any required command-level follow-up.

## Boundaries

- Avoid broad plugin/orchestrator rewrites unless directly required by tool behavior.
- Keep outputs machine-parseable where tools are consumed by automation loops.
- Preserve non-destructive defaults and policy restrictions.
