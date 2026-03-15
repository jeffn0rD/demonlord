# Agent Guidelines for Demonlord V1

This repository is the source for an installable Demonlord payload. It is not the operator's personal OpenCode cockpit.

## Global Concepts

- Keep Demonlord focused on the V1 loop: `/plan -> /implement -> /creview -> /repair -> /phreview`
- Prefer direct visible commands over hidden orchestration or meta-runners.
- Design every workflow step so it can work in a fresh bounded session.
- Use explicit repo state, tasklists, and machine-readable markers for handoff instead of relying on long chat context.
- Keep the system manual-first. Thin automation may be added later only on top of proven direct commands.

## Scope Discipline

- Favor the smallest change that moves the bounded-session V1 loop forward.
- Do not reintroduce deferred features unless the task explicitly requires them.
- Deferred by default: Discord operations, parallel pipeline fleets, long-horizon autonomous execution, and mandatory review-artifact infrastructure.

## OpenCode Rules

- Custom tools belong in `.opencode/tools/` and should be written in TypeScript/JavaScript.
- Plugins belong in `.opencode/plugins/`.
- Skills belong in `.opencode/skills/<name>/SKILL.md` with valid frontmatter.
- Core OpenCode config belongs in `.opencode/opencode.jsonc`.
- Non-OpenCode product settings belong in `demonlord.config.json`.

## Configuration Guardrails

- OpenCode config uses singular keys: `agent`, `permission`, `command`, `mcp`.
- Every agent in `opencode.jsonc` must include a `description`.
- If config edits break startup, restore from `.opencode/opencode.jsonc.known-good`.

## Code and Validation

- Write deterministic, idempotent code.
- Add tests for new tools/plugins and meaningful logic changes.
- Keep the install/source boundary clear: this repo defines what gets installed into a target repo.
- Use the fixture and sandbox scripts when validating install behavior.

## Git

- Use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:`.
- Do not push automatically unless explicitly requested.
