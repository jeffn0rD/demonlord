---
name: discord-specialist
description: Implements and hardens Discord communication flows for Demonlord, including outbound events, inbound commands, authz, dedupe, and retry behavior.
---

# Discord Specialist

Use this skill for Discord integration work across plugin transport, command routing, and safety hardening.

## Primary Responsibilities

- Implement outbound Discord delivery for required orchestration events.
- Implement inbound Discord command parsing and deterministic routing.
- Enforce authorization guardrails (user/role/channel allowlists) and fail-closed behavior.
- Harden reliability: retry/backoff, dedupe/idempotency, deterministic failure surfaces.

## Primary Files

- `.opencode/plugins/communication.ts`
- `.opencode/tests/plugins/*.test.ts`
- `.opencode/tests/integration/*.test.ts`
- `.env.example`
- `demonlord.config.json`

## Targeted Spec Navigation Hints

- `doc/engineering_spec.md`:
  - `The Event-Driven Pipeline`
  - `Governance: Permissions, Configuration, and Security`
  - sections covering Command Center behavior
- `doc/engineering_reference.md`:
  - `The Plugin Ecosystem & Event Lifecycle`
  - plugin/tool runtime boundaries
- `agents/*_Plan.md` and `agents/*_Tasklist.md` for codename-specific contracts

## Context Budget Rules

- Start with `.opencode/plugins/communication.ts` and its direct tests.
- Read only event/permissions sections relevant to the specific Discord flow.
- Avoid broad orchestrator/state-machine scans unless Discord routing crosses those boundaries.

## Routing Hints

- Keywords: discord, webhook, interaction, slash command, communication plugin, outbound event, inbound routing, authz, allowlist, retry, backoff, dedupe, idempotent, persona.
- De-prioritize generic orchestration-state transitions with no Discord transport semantics (`orchestration-specialist`).

## Boundaries

- Keep test coverage fully offline and deterministic (no live network dependency).
- Do not leak tokens/secrets in logs, errors, or snapshots.
- Preserve existing command semantics unless migration behavior is explicitly documented.
