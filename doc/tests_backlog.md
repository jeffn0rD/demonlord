** TESTING BACKLOG **
Tests that will need to be done when system is in an alpha development stage

** TEST LIST **

1. In the dashboard, run `/party frontend-specialist backend-specialist`; verify response includes Party Mode round/state details without entering an LLM chatter loop.
2. Run `/focus backend-specialist`, then `/continue discuss API boundaries`; verify persisted state updates in responses (focus changes and round increments).
3. Run `/export`; verify transcript is written to `_bmad-output/party-mode/party-mode-transcript-<session_id>.md` and includes `Metadata` plus numbered `Timeline` sections.
4. Run `/export ../../escape.md` (or another path-traversal attempt) and verify an explicit validation error is returned with no Party Mode state corruption.
5. In the dashboard, open a triage/root session and run `/pipeline advance implementation`; verify response includes `awaiting_approval` transition state and no implementation child session is spawned yet.
6. Let that same session hit idle repeatedly (or trigger idle twice), then run `/pipeline status`; verify only one pending transition exists (no duplicate spawn requests logged).
7. Run `/pipeline approve` in the same session; verify exactly one implementation session is created and linked in the pipeline session tree.
8. In the dashboard, run the `submit_implementation` tool with an invalid commit message (non-Conventional Commit format like "bad message") and confirm schema validation rejects it with a clear error about the required format.
9. Make a deliberate lint or test failure in a branch, run `submit_implementation` with `auto_fix=false`, and confirm the response includes `stage` (e.g., "lint" or "test"), `stderr`, and a `stack_trace` field.
10. Modify one API file (e.g., add a file in `api/routes/`) and one UI file (e.g., add a `.tsx` component), run `submit_implementation` with `generate_tests=true`, and confirm generated templates appear in `tests/generated/api/` and `tests/generated/e2e/` with semantic locator usage (e.g., `data-testid`).
11. With lint/test passing, run `submit_implementation` with a valid commit message (e.g., `feat: add new feature`) and confirm it performs the commit+push flow or returns deterministic failure details if remote/auth is unavailable.
12. In the dashboard, open README.md and confirm Quick Start includes the exact required step `cd .opencode && npm install`.
13. Open USAGE.md and confirm "First-Time Setup" shows the 3-step flow: inject assets, install in `.opencode`, then run `./scripts/bootstrap.sh`.
14. Open `.env.example` and confirm placeholders exist for `GITHUB_PAT`, `PROJECT_V2_TOKEN`, all `DISCORD_WEBHOOK_*` values, and `DISCORD_BOT_TOKEN`.
15. In a terminal from repo root, run `npm run lint` and `npm run test` to confirm the root quality-gate bootstrap scripts succeed immediately.
16. In the dashboard, create a dummy triage session (e.g., "Hello World task"), then run `/pipeline status` and verify stage/transition details appear with deterministic state output.
17. Advance the pipeline through `/pipeline advance implementation` then `/pipeline approve`, and confirm a child implementation session appears with worktree metadata in status output.
18. Move to review (`/pipeline advance review` + approval if prompted), let review go idle, and verify terminal completion messaging is emitted once (no duplicate loop behavior).
19. Run Party Mode controls (`/party`, `/continue`, `/focus backend-specialist`, `/export`) and confirm state updates plus transcript export behavior in the session output.
20. In the dashboard, start an implementation flow for a task that includes a task ref (for example `T-3.7.2`) and run `/pipeline status`; confirm routing now shows execution target agent/role/tier and task ref.
21. Trigger a flow where the task description has no `T-...` reference; confirm orchestration continues via legacy fallback and emits a warning event (not a hard failure).
22. Temporarily set an unresolved tier pool in `demonlord.config.json` (for example a tier with only nonexistent agent IDs), advance pipeline to implementation, and verify it enters blocked state with explicit reason.
23. Restore normal config, rerun transition, and verify deterministic fallback selection (requested tier or default tier or legacy singleton) is reflected in status/event output.
24. Trigger a spec-first flow that generates a valid handoff marker, then continue to implementation; verify post-handoff spawn preserves the same resolved `taskRef`, `role`, `tier`, and `agentID` chosen before handoff.
25. Temporarily corrupt `.opencode/opencode.jsonc` (for example invalid JSONC syntax) and start implementation routing; verify resolver fails closed to `task_blocked` with explicit config-parse reason and does not select permissive pool IDs.
26. Run `/implement` where the session title lacks a `T-...` token but traversal selected a task with `EXECUTION` metadata; verify routing still uses the selected-task metadata and does not emit false missing-metadata fallback.
27. Start a triage session for a task with explicit `EXECUTION` metadata (for example `T-3.7.7` from a tasklist), confirm the spawned implementation session uses the metadata-selected role/tier/agent (not legacy defaults) and verify `metadataSource` is "tasklist" in status.
28. Run a task with missing `EXECUTION` metadata (for example a task that only has `<!-- TASK:... -->` without following EXECUTION), confirm pipeline activity shows a warning-level `routing_warning` event and uses legacy fallback behavior.
29. Trigger a spec-first flow (for example a task with requirements in title like "requirements are unclear"), complete the spec handoff marker, and confirm the post-handoff implementation session keeps the same resolved execution target (`agentID`, `role`, `tier`, `taskRef`) chosen before the spec session.
30. Verify that task traversal context (`taskRef`, `tasklistPath`) is persisted in pipeline state and reused across retries, approvals, and idle resume events rather than re-deriving from session title each time.
