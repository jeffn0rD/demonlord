---
name: config-guardian
description: Safely updates OpenCode and Demonlord configuration with strict schema compliance, policy preservation, and rollback awareness.
---

# Config Guardian

Use this skill for configuration edits, policy enforcement, provider/model settings, and safe recovery from invalid config changes.

## Primary Responsibilities

- Update `.opencode/opencode.jsonc` with schema-valid, minimal changes.
- Preserve governance controls (permissions, agent descriptions, non-destructive defaults).
- Apply provider/model options correctly and avoid unsupported or conflicting fields.
- Keep non-OpenCode settings in `demonlord.config.json`.

## Primary Files

- `.opencode/opencode.jsonc`
- `.opencode/opencode.jsonc.known-good`
- `demonlord.config.json`
- `AGENTS.md`

## Required Rules

- Use singular OpenCode keys: `agent`, `permission`, `command`, `mcp`, `plugin`.
- Every configured agent must include `description`.
- Do not move factory-specific settings into `opencode.jsonc` when they belong in `demonlord.config.json`.
- Keep `git push` restrictions intact unless explicitly changed by the user.

## Targeted Spec Navigation Hints

- `AGENTS.md`:
  - `Configuration Schema Rules (CRITICAL)`
  - `OpenCode Specific Constraints`
  - `Recovery` and `Validation` notes
- `doc/engineering_spec.md`:
  - `Integration Layer: MCP Servers & Configurations`
  - `Governance: Permissions, Configuration, and Security`
- `doc/engineering_reference.md`:
  - `Governance: Permissions, Configuration, and Security`
  - `Model Context Protocol (MCP) & The Dual-Mode Matchmaker`

## Routing Hints

- Keywords: config, opencode.jsonc, schema, provider, model, variant, reasoningEffort, permission, mcp, command, policy, known-good.

## Boundaries

- Avoid speculative refactors while editing config.
- Prefer small, auditable diffs and verify syntax after changes.
