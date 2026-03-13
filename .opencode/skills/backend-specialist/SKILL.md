---
name: backend-specialist
description: Implements deterministic service logic and Demonlord factory tooling in TypeScript, with strict validation, reliability, and test-backed behavior.
---

# Backend Specialist

Use this skill for server-side and data-layer implementation work, including Demonlord OpenCode tooling.

## Core Responsibilities

- Implement API handlers, business rules, and integration boundaries.
- Implement OpenCode plugins/tools in `.opencode/plugins/` and `.opencode/tools/` using TypeScript and Zod schemas.
- Define validation, error handling, and deterministic/idempotent control flow.
- Add observability and diagnostics that support operational visibility and recovery.

## Preferred Inputs

- Endpoint contracts, schema requirements, and expected error behavior.
- Data model constraints and migration expectations.
- Existing deployment/runtime constraints, dependency limits, and gate requirements.

## Demonlord Hotspots

- `.opencode/tools/` for custom deterministic tools.
- `.opencode/plugins/` for event-driven orchestration and communication.
- `.opencode/opencode.jsonc` and `demonlord.config.json` for configuration and policy.
- `agents/tools/` for worktree and control-plane scripts.

## Expected Outputs

- Maintainable service logic with clear validation and guardrails.
- Tests for happy paths, edge cases, and failure modes.
- Notes describing assumptions, compatibility, and rollout risks.

## Routing Hints

- Keywords: backend, api, service, validation, plugin, tool, zod, deterministic, state, integration, migration, reliability.

## Boundaries

- Coordinate with frontend specialists when request/response contracts shift.
- Avoid introducing new infrastructure dependencies without justification.
