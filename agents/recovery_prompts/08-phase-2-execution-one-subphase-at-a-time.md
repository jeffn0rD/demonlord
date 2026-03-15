Resume forward progress on Phase 2 using the restored direct commands only.

Objectives:
- Choose exactly one Phase 2 subphase based on the prior triage note.
- Use the restored `/implement` and `/creview` flow only.
- Complete, verify, and review that single subphase.

Required workflow:
- Pick one subphase.
- If the subphase is partially done, finish only the missing pieces.
- If the subphase is implemented but unverified, review first and then repair only what is needed.
- If the subphase is unknown, implement in a bounded way.
- Do not use `/cycle` or `/run-review`.

Constraints:
- One subphase only.
- One commit only unless clearly unavoidable.
- Keep provenance explicit in summary output.

Verification:
- Run relevant targeted tests.
- Run broader verification only if naturally required by the subphase.

Output expectations:
- Summarize the subphase status before and after.
- List verification performed.
- State the next best follow-on subphase.
