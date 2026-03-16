---
description: Maintain skills index and skill-reference hygiene [check|write]
agent: orchestrator
---

Run deterministic maintenance for skill documentation and reference hygiene.

Inputs:
- mode: `$1` (optional, `write` default, allowed: `write`, `check`)

Execution contract:
1. If `$1` is missing, use `write` mode.
2. In `write` mode, run:
   - `node payload/dot-opencode/scripts/skill_docs_maintenance.mjs --write`
   - then `node payload/dot-opencode/scripts/skill_docs_maintenance.mjs --check`
3. In `check` mode, run:
   - `node payload/dot-opencode/scripts/skill_docs_maintenance.mjs --check`
4. Return a concise summary including mode, pass/fail status, and changed files (if any).
5. If maintenance fails, surface the script errors verbatim and list the exact file paths needing updates.

Notes:
- This command is safe to run every phase cycle.
- The maintenance script owns `doc/agent_docs_index.md`; do not hand-edit that file.

Examples:
- `/skills-maintain`
- `/skills-maintain write`
- `/skills-maintain check`
