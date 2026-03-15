# Demonlord Project Context

## Mission
You are working inside an isolated git worktree for the Demonlord autonomous factory.

## Operating Rules
- Prefer deterministic, idempotent changes.
- Keep commit scopes small and traceable.
- Run local validation before handing work back.
- Respect OpenCode config constraints in `.opencode/opencode.jsonc`.

## Mandatory Startup Checklist
1. Read this file fully before making edits.
2. Review the current subphase in `agents/*_Tasklist.md`.
3. Check `agents/*_Plan.md` for phase context and constraints.
4. Validate with the relevant build/test commands before completion.
