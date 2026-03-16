---
description: Deterministic orchestration pipeline controls
agent: orchestrator
---

Use this command to inspect and control orchestration pipeline state.

Supported actions:
- `/pipeline status [session_id]`
- `/pipeline advance <triage|implementation|review> [session_id]`
- `/pipeline approve [session_id]`
- `/pipeline stop [session_id]`
- `/pipeline off`
- `/pipeline on`

This command is handled by `.opencode/plugins/orchestrator.ts`.
