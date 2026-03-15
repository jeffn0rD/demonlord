---
description: Run minimal sub-session marker visibility test
agent: reviewer
---

Run the deterministic dummy marker-visibility test.

Hard constraints:
- Call the `dummy_test` tool exactly once.
- Do not run shell commands, SDK snippets, or ad hoc wrappers.
- Return tool failure verbatim when `ok=false`.

Execution contract:
1. Call `dummy_test` with no arguments.
2. Return a concise summary including:
   - child command executed,
   - marker found (`yes`/`no`),
   - parsed answer text,
   - output source (`command_parts` or `session_messages`),
   - session id,
   - and output excerpt.
