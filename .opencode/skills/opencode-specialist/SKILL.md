---
name: opencode-specialist
description: Implements and hardens OpenCode command/tool workflows, session automation loops, and deterministic command contracts.
---

# OpenCode Specialist

Use this skill for OpenCode-native command and tooling work, especially when implementing deterministic workflow automation.

## Primary Responsibilities

- Build and maintain command definitions in `.opencode/commands/`.
- Integrate command behavior with deterministic tool interfaces in `.opencode/tools/`.
- Harden machine-readable command contracts for automation (`/implement`, `/creview`, `/mreview`, `/repair`, `/cycle`).
- Preserve session isolation and low-context orchestration patterns for long-running loops.

## Primary Files

- `.opencode/commands/*.md`
- `.opencode/tools/*.ts`
- `.opencode/tests/tools/*.test.ts`
- `.opencode/plugins/orchestrator.ts` (only when command/tool changes require integration)

## Context Budget Rules

- Start from the command contract file, then trace only directly connected tool handlers.
- Read schema and output markers before reading broader docs.
- Use referenced spec sections selectively; avoid full-document ingestion.

## Targeted Spec Navigation Hints

- `doc/engineering_reference.md`:
  - `Custom Tool Implementation & Schema Design`
  - `The Plugin Ecosystem & Event Lifecycle`
  - `Governance: Permissions, Configuration, and Security`
- `doc/engineering_spec.md`:
  - `The Workflow State Machine`
  - `Operational Modes and Manual Controls`
  - `Abort and Error Policy`
- `AGENTS.md`:
  - `OpenCode Specific Constraints`
  - `Configuration Schema Rules (CRITICAL)`

## Routing Hints

- Keywords: opencode, command, slash command, tool schema, deterministic output, cycle loop, implement, creview, mreview, repair, session automation, machine-readable marker, noReply.
- De-prioritize isolated custom tool implementation with no command-contract impact (`demonlord-tooling-specialist`).
- De-prioritize runtime recovery/runbook triage (`demonlord-ops-specialist`).

## Boundaries

- Prefer deterministic state/artifact-driven flow over prompt-only control.
- Do not introduce non-auditable or stochastic automation behavior.
- Keep changes backward-compatible with existing command usage unless migration is explicitly requested.

## OpenCode SDK Reference: Sessions API

Source: https://opencode.ai/docs/sdk/

**Creating a client:**
```typescript
import { createOpencodeClient } from "@opencode-ai/sdk"
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" })
```

**Session methods (from SDK):**

| Method | Description | Returns |
|--------|-------------|---------|
| `session.create({ body })` | Create session | `{ id: string, ... }` |
| `session.delete({ path })` | Delete session | `boolean` |
| `session.command({ path, body })` | Send command to session | `{ info: AssistantMessage, parts: Part[] }` |
| `session.prompt({ path, body })` | Send prompt message | `AssistantMessage` or `UserMessage` (if `noReply: true`) |
| `session.get({ path })` | Get session | `Session` |
| `session.list()` | List sessions | `Session[]` |
| `session.children({ path })` | List child sessions | `Session[]` |
| `session.update({ path, body })` | Update session properties | `Session` |
| `session.abort({ path })` | Abort a running session | `boolean` |
| `session.messages({ path })` | List messages | `{ info: Message, parts: Part[] }[]` |

**Example: Spawn a sub-session and get output:**
```typescript
// 1. Create session
const created = await client.session.create({
  body: { title: "My sub-session" },
  query: { directory: worktreePath }
});
const sessionID = created.data.id;

try {
  // 2. Send command or prompt
  const result = await client.session.command({
    path: { id: sessionID },
    body: {
      command: "mycommand",
      arguments: "arg1 arg2",
      agent: "general"
    },
    query: { directory: worktreePath }
  });
  
  // 3. Extract output from parts
  const outputText = result.data.parts
    .filter(p => p.type === "text")
    .map(p => p.text)
    .join("");
    
} finally {
  // 4. Cleanup
  await client.session.delete({ path: { id: sessionID } });
}
```

**Note: There is NO `session.spawn()` method. Use `create` + `command`/`prompt` + `delete` pattern.**
