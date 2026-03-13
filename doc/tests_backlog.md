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
