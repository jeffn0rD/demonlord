# OpenCode Local Patch: `command.execute.before` `noReply`

This document preserves the local OpenCode core patch used by Demonlord to make control commands (`/pipeline`, `/approve`) return deterministic output without a visible LLM reasoning turn.

## Why this patch exists

- Current OpenCode command pre-hook type supports `parts` mutation but not an explicit no-reply short-circuit for command execution.
- Result: control commands can still look like normal LLM command prompts (`Thinking: ...`) even when plugin logic has already handled them.
- Local patch adds `noReply?: boolean` to the `command.execute.before` hook output and threads it into command execution.

Reference issue: `https://github.com/anomalyco/opencode/issues/9306`

## Patch target

- Repository: `/home/jeff0r/work/opencode`
- Branch: `dev` (local workflow)
- Files:
  - `packages/plugin/src/index.ts`
  - `packages/opencode/src/session/prompt.ts`

## Minimal diff

```diff
diff --git a/packages/plugin/src/index.ts b/packages/plugin/src/index.ts
--- a/packages/plugin/src/index.ts
+++ b/packages/plugin/src/index.ts
@@
   "command.execute.before"?: (
     input: { command: string; sessionID: string; arguments: string },
-    output: { parts: Part[] },
+    output: { parts: Part[]; noReply?: boolean },
   ) => Promise<void>

diff --git a/packages/opencode/src/session/prompt.ts b/packages/opencode/src/session/prompt.ts
--- a/packages/opencode/src/session/prompt.ts
+++ b/packages/opencode/src/session/prompt.ts
@@
-    await Plugin.trigger(
+    const hookOutput = {
+      parts,
+      noReply: false,
+    }
+
+    await Plugin.trigger(
       "command.execute.before",
       {
         command: input.command,
         sessionID: input.sessionID,
         arguments: input.arguments,
       },
-      { parts },
+      hookOutput,
     )

     const result = (await prompt({
       sessionID: input.sessionID,
       messageID: input.messageID,
       model: userModel,
       agent: userAgent,
-      parts,
+      parts: hookOutput.parts,
+      noReply: hookOutput.noReply,
       variant: input.variant,
     })) as MessageV2.WithParts
```

## Apply patch (local)

```bash
cd /home/jeff0r/work/opencode
git checkout dev
git apply <<'PATCH'
diff --git a/packages/plugin/src/index.ts b/packages/plugin/src/index.ts
--- a/packages/plugin/src/index.ts
+++ b/packages/plugin/src/index.ts
@@
   "command.execute.before"?: (
     input: { command: string; sessionID: string; arguments: string },
-    output: { parts: Part[] },
+    output: { parts: Part[]; noReply?: boolean },
   ) => Promise<void>
diff --git a/packages/opencode/src/session/prompt.ts b/packages/opencode/src/session/prompt.ts
--- a/packages/opencode/src/session/prompt.ts
+++ b/packages/opencode/src/session/prompt.ts
@@
-    await Plugin.trigger(
+    const hookOutput = {
+      parts,
+      noReply: false,
+    }
+
+    await Plugin.trigger(
       "command.execute.before",
       {
         command: input.command,
         sessionID: input.sessionID,
         arguments: input.arguments,
       },
-      { parts },
+      hookOutput,
     )

     const result = (await prompt({
       sessionID: input.sessionID,
       messageID: input.messageID,
       model: userModel,
       agent: userAgent,
-      parts,
+      parts: hookOutput.parts,
+      noReply: hookOutput.noReply,
       variant: input.variant,
     })) as MessageV2.WithParts
PATCH
```

## Demonlord-side usage

After patching OpenCode core, Demonlord plugins should set `output.noReply = true` in pre-hooks for control commands:

- `.opencode/plugins/orchestrator.ts`: `/pipeline ...`
- `.opencode/plugins/communication.ts`: `/approve`

Expected behavior: control commands return immediate deterministic output without a visible LLM reasoning turn.

## Verification

```bash
cd /home/jeff0r/work/opencode
bun --cwd packages/opencode typecheck
```

Run patched OpenCode against Demonlord:

```bash
cd /home/jeff0r/work/opencode
bun dev /home/jeff0r/work/demonlord
```

Smoke test in OpenCode:

1. `/pipeline status`
2. `/pipeline off`
3. `/pipeline on`

Success criteria:

- command output appears immediately
- no `Thinking: Analyzing Command Intent` for these control commands
- orchestration events are recorded once per command

## Rollback

```bash
cd /home/jeff0r/work/opencode
git restore packages/plugin/src/index.ts packages/opencode/src/session/prompt.ts
```
