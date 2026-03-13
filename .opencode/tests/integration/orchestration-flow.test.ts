import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { Event, Session } from "@opencode-ai/sdk";
import OrchestratorPlugin, { __orchestratorTestUtils } from "../../plugins/orchestrator.ts";

type PipelineStage = "triage" | "implementation" | "review";
type TransitionState = "idle" | "awaiting_approval" | "in_progress" | "blocked" | "completed" | "stopped";

interface PipelineSessionFixture {
  sessionID: string;
  stage: PipelineStage;
  parentSessionID?: string;
  directory?: string;
  children: string[];
  status: "active" | "completed" | "blocked" | "stopped";
}

interface PendingTransitionFixture {
  from: PipelineStage;
  to: PipelineStage;
  requestedBySessionID: string;
  approvalRequired: boolean;
  approved: boolean;
  requestedAt: number;
}

interface OrchestrationEventFixture {
  at: string;
  type: string;
  rootSessionID: string;
  sessionID: string;
  stage: PipelineStage;
}

interface PipelineFixture {
  rootSessionID: string;
  currentStage: PipelineStage;
  transition: TransitionState;
  sessions: Record<string, PipelineSessionFixture>;
  routing?: {
    skillID?: string;
    mode?: "llm" | "heuristic";
    reason?: string;
    agentID?: string;
    role?: "planning" | "implementation" | "review";
    tier?: "lite" | "standard" | "pro";
    taskRef?: string;
    metadataSource?: "tasklist" | "legacy";
  };
  taskTraversal?: {
    taskDescription?: string;
    taskRef?: string;
    tasklistPath?: string;
  };
  specHandoff?: {
    required: boolean;
    completed: boolean;
    markerPath: string;
    markerSessionID?: string;
    targetSkillID: string;
  };
  terminalNotified: boolean;
  stopped: boolean;
  stopReason?: "manual" | "global_off" | "completed";
  pendingTransition?: PendingTransitionFixture;
  error: {
    inProgress: boolean;
    attempts: number;
    handledSignatures: string[];
  };
  events: OrchestrationEventFixture[];
  createdAt: number;
  updatedAt: number;
}

describe("orchestration off/on control semantics", () => {
  test("global off marks non-manual pipelines and global on resumes only global_off pipelines", () => {
    const pipelines: Record<string, PipelineFixture> = {
      manual: {
        rootSessionID: "manual",
        currentStage: "triage",
        transition: "stopped",
        sessions: {},
        terminalNotified: false,
        stopped: true,
        stopReason: "manual",
        error: { inProgress: false, attempts: 0, handledSignatures: [] },
        events: [],
        createdAt: 1,
        updatedAt: 1,
      },
      queued: {
        rootSessionID: "queued",
        currentStage: "implementation",
        transition: "idle",
        sessions: {},
        terminalNotified: false,
        stopped: false,
        pendingTransition: {
          from: "implementation",
          to: "review",
          requestedBySessionID: "queued",
          approvalRequired: true,
          approved: false,
          requestedAt: 2,
        },
        error: { inProgress: false, attempts: 0, handledSignatures: [] },
        events: [],
        createdAt: 2,
        updatedAt: 2,
      },
      terminal: {
        rootSessionID: "terminal",
        currentStage: "review",
        transition: "completed",
        sessions: {},
        terminalNotified: true,
        stopped: true,
        stopReason: "completed",
        error: { inProgress: false, attempts: 0, handledSignatures: [] },
        events: [],
        createdAt: 3,
        updatedAt: 3,
      },
    };

    __orchestratorTestUtils.applyGlobalOffToPipelines(
      pipelines as unknown as Parameters<typeof __orchestratorTestUtils.applyGlobalOffToPipelines>[0],
    );

    assert.equal(pipelines.manual.stopReason, "manual");
    assert.equal(pipelines.queued.stopReason, "global_off");
    assert.equal(pipelines.queued.transition, "stopped");
    assert.equal(pipelines.terminal.stopReason, "completed");

    const resumed = __orchestratorTestUtils.applyGlobalOnToPipelines(
      pipelines as unknown as Parameters<typeof __orchestratorTestUtils.applyGlobalOnToPipelines>[0],
    );

    assert.equal(resumed, 1);
    assert.equal(pipelines.manual.stopReason, "manual");
    assert.equal(pipelines.queued.stopped, false);
    assert.equal(pipelines.queued.stopReason, undefined);
    assert.equal(pipelines.queued.transition, "awaiting_approval");
    assert.equal(pipelines.terminal.transition, "completed");
  });
});

describe("orchestrator integration flow", () => {
  test("manual command progression creates approval-gated transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-manual-"));

    try {
      await writeConfig(root, {
        enabled: true,
        mode: "manual",
        require_approval_before_spawn: true,
        ignore_aborted_messages: true,
        verbose_events: false,
      });

      const client = createMockClient(root);
      const plugin = await createPlugin(client, root);

      await emitEvent(plugin, sessionCreatedEvent("ses-root", root, "triage: add integration coverage"));
      await emitEvent(plugin, commandExecutedEvent("ses-root", "advance implementation"));

      const snapshot = await readSnapshot<PipelineFixture>(root);
      const pipeline = snapshot.pipelines["ses-root"];

      assert.equal(pipeline.currentStage, "triage");
      assert.equal(pipeline.transition, "awaiting_approval");
      assert.equal(pipeline.pendingTransition?.from, "triage");
      assert.equal(pipeline.pendingTransition?.to, "implementation");
      assert.equal(client.creates.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("repeated idle events do not duplicate spawn requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-idle-"));

    try {
      await writeConfig(root, {
        enabled: true,
        mode: "auto",
        require_approval_before_spawn: true,
        ignore_aborted_messages: true,
        verbose_events: false,
      });

      const client = createMockClient(root);
      const plugin = await createPlugin(client, root);

      await emitEvent(plugin, sessionCreatedEvent("ses-auto", root, "triage: harden lifecycle"));
      await emitEvent(plugin, sessionIdleEvent("ses-auto"));
      await emitEvent(plugin, sessionIdleEvent("ses-auto"));

      const eventLog = await readEventLog(root);
      const requested = eventLog.filter((entry) => entry.type === "spawn_requested");
      const blocked = eventLog.filter((entry) => entry.type === "spawn_blocked");

      assert.equal(requested.length, 1);
      assert.equal(blocked.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("queued control commands advance pipeline deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-queue-"));

    try {
      await writeConfig(root, {
        enabled: true,
        mode: "manual",
        require_approval_before_spawn: true,
        ignore_aborted_messages: true,
        verbose_events: false,
      });

      const client = createMockClient(root);
      const plugin = await createPlugin(client, root);

      await emitEvent(plugin, sessionCreatedEvent("ses-queue", root, "triage: queue driven"));

      const before = await readSnapshot<PipelineFixture>(root);
      const pipeline = before.pipelines["ses-queue"];
      const queuePath = resolve(root, "_bmad-output", "orchestration-commands.ndjson");

      const queuedCommand = {
        version: 1,
        id: "pcmd-test",
        source: "pipelinectl",
        action: "advance",
        sessionID: "ses-queue",
        targetSessionID: "ses-queue",
        stage: "implementation",
        dedupeKey: `advance:ses-queue:${pipeline.updatedAt}`,
        requestedAt: new Date().toISOString(),
        expectation: {
          rootSessionID: "ses-queue",
          stage: "triage",
          transition: "idle",
          pipelineUpdatedAt: pipeline.updatedAt,
        },
      };
      await writeFile(queuePath, `${JSON.stringify(queuedCommand)}\n`, "utf-8");

      await emitEvent(plugin, sessionIdleEvent("ses-queue"));

      const after = await readSnapshot<PipelineFixture>(root);
      const updatedPipeline = after.pipelines["ses-queue"];
      assert.equal(updatedPipeline.transition, "awaiting_approval");
      assert.equal(updatedPipeline.pendingTransition?.to, "implementation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("session.error deduplicates recovery handling and records one recovery prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-error-"));

    try {
      await writeConfig(root, {
        enabled: true,
        mode: "auto",
        require_approval_before_spawn: true,
        ignore_aborted_messages: true,
        verbose_events: false,
      });

      const client = createMockClient(root);
      const plugin = await createPlugin(client, root);

      await emitEvent(plugin, sessionCreatedEvent("ses-root-error", root, "triage: reproduce failures"));
      await emitEvent(
        plugin,
        sessionCreatedEvent("ses-impl-error", root, "implementation:error-hardening", "ses-root-error"),
      );

      const errorMessage = "request 123 failed for ticket 99";
      await emitEvent(plugin, sessionErrorEvent("ses-impl-error", errorMessage));
      await emitEvent(plugin, sessionErrorEvent("ses-impl-error", errorMessage));

      const snapshot = await readSnapshot<PipelineFixture>(root);
      const pipeline = snapshot.pipelines["ses-root-error"];
      const events = await readEventLog(root);
      const recoveryPrompts = client.prompts.filter(
        (entry) => entry.sessionID === "ses-impl-error" && entry.text.includes("Recovery attempt"),
      );

      assert.equal(pipeline.error.attempts, 1);
      assert.equal(pipeline.error.inProgress, false);
      assert.equal(pipeline.error.handledSignatures.length, 1);
      assert.equal(recoveryPrompts.length, 1);
      assert.equal(events.filter((entry) => entry.type === "error").length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("review idle transitions pipeline to completed once and emits terminal prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-review-idle-"));

    try {
      await writeConfig(root, {
        enabled: true,
        mode: "manual",
        require_approval_before_spawn: true,
        ignore_aborted_messages: true,
        verbose_events: false,
      });

      const client = createMockClient(root);
      const plugin = await createPlugin(client, root);

      await emitEvent(plugin, sessionCreatedEvent("ses-root-review", root, "triage: close pipeline"));
      await emitEvent(plugin, sessionCreatedEvent("ses-impl-review", root, "implementation:handoff", "ses-root-review"));
      await emitEvent(plugin, sessionCreatedEvent("ses-review", root, "review:final-check", "ses-impl-review"));

      await emitEvent(plugin, sessionIdleEvent("ses-review"));
      await emitEvent(plugin, sessionIdleEvent("ses-review"));

      const snapshot = await readSnapshot<PipelineFixture>(root);
      const pipeline = snapshot.pipelines["ses-root-review"];
      const reviewSession = pipeline.sessions["ses-review"];
      const rootPrompts = client.prompts.filter(
        (entry) => entry.sessionID === "ses-root-review" && entry.text.includes("Pipeline terminal state reached"),
      );

      assert.equal(pipeline.transition, "completed");
      assert.equal(pipeline.currentStage, "review");
      assert.equal(pipeline.terminalNotified, true);
      assert.equal(pipeline.stopped, true);
      assert.equal(pipeline.stopReason, "completed");
      assert.equal(reviewSession?.status, "completed");
      assert.equal(rootPrompts.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses tasklist EXECUTION metadata as primary runtime routing source", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-routing-explicit-"));

    try {
      await writeConfig(
        root,
        {
          enabled: true,
          mode: "auto",
          require_approval_before_spawn: false,
          ignore_aborted_messages: true,
          verbose_events: false,
        },
        {
          task_routing: { source: "tasklist_explicit", default_tier: "standard" },
          agent_pools: {
            implementation: {
              pro: ["minion-pro"],
              standard: ["minion-standard"],
            },
          },
        },
      );
      await writeOpencodeAgentConfig(root, ["planner", "minion", "minion-standard", "minion-pro", "reviewer"]);
      await writeSpawnWorktreeScript(root);
      await writeTasklist(
        root,
        "minion_Tasklist.md",
        [
          "<!-- TASK:T-3.7.7 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"pro","skill":"orchestration-specialist","parallel_group":"routing-remediation","depends_on":["T-3.7.3"]}} -->',
          "- [ ] **T-3.7.7**: preserve execution target across spec handoff.",
        ].join("\n"),
      );

      const client = createMockClient(root);
      const plugin = await createPlugin(client, root);

      await emitEvent(
        plugin,
        sessionCreatedEvent("ses-root-explicit", root, "triage: execute T-3.7.7 from minion_Tasklist.md"),
      );
      await emitEvent(plugin, sessionIdleEvent("ses-root-explicit"));

      const snapshot = await readSnapshot<PipelineFixture>(root);
      const pipeline = snapshot.pipelines["ses-root-explicit"];

      assert.equal(pipeline.transition, "completed");
      assert.equal(pipeline.currentStage, "implementation");
      assert.equal(pipeline.routing?.skillID, "orchestration-specialist");
      assert.equal(pipeline.routing?.agentID, "minion-pro");
      assert.equal(pipeline.routing?.role, "implementation");
      assert.equal(pipeline.routing?.tier, "pro");
      assert.equal(pipeline.routing?.taskRef, "T-3.7.7");
      assert.equal(pipeline.routing?.metadataSource, "tasklist");
      assert.match(pipeline.taskTraversal?.tasklistPath ?? "", /minion_Tasklist\.md$/);
      assert.equal(client.creates.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits warning-level fallback when EXECUTION metadata is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-routing-warning-"));

    try {
      await writeConfig(
        root,
        {
          enabled: true,
          mode: "auto",
          require_approval_before_spawn: false,
          ignore_aborted_messages: true,
          verbose_events: false,
        },
        {
          task_routing: { source: "tasklist_explicit", default_tier: "standard" },
          agent_pools: {
            implementation: {
              standard: ["minion-standard"],
            },
          },
        },
      );
      await writeOpencodeAgentConfig(root, ["planner", "minion", "minion-standard", "reviewer"]);
      await writeSkillCatalog(root, ["backend-specialist"]);
      await writeSpawnWorktreeScript(root);
      await writeTasklist(
        root,
        "minion_Tasklist.md",
        [
          "<!-- TASK:T-3.7.8 -->",
          "- [ ] **T-3.7.8**: metadata lookup must use persisted traversal context.",
        ].join("\n"),
      );

      const client = createMockClient(root);
      const plugin = await createPlugin(client, root);

      await emitEvent(
        plugin,
        sessionCreatedEvent(
          "ses-root-warning",
          root,
          "triage: execute T-3.7.8 from minion_Tasklist.md with deterministic fallback",
        ),
      );
      await emitEvent(plugin, sessionIdleEvent("ses-root-warning"));

      const snapshot = await readSnapshot<PipelineFixture>(root);
      const pipeline = snapshot.pipelines["ses-root-warning"];
      const eventLog = await readEventLog(root);

      assert.equal(pipeline.routing?.metadataSource, "legacy");
      assert.equal(pipeline.routing?.taskRef, "T-3.7.8");
      assert.equal(eventLog.some((entry) => entry.type === "routing_warning"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("blocks deterministic routing when requested tier pool is unresolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-routing-blocked-"));

    try {
      await writeConfig(
        root,
        {
          enabled: true,
          mode: "auto",
          require_approval_before_spawn: false,
          ignore_aborted_messages: true,
          verbose_events: false,
        },
        {
          task_routing: { source: "tasklist_explicit", default_tier: "standard" },
          agent_pools: {
            implementation: {
              pro: ["minion-pro"],
              standard: ["minion-standard"],
            },
          },
        },
      );
      await writeOpencodeAgentConfig(root, ["reviewer"]);
      await writeTasklist(
        root,
        "minion_Tasklist.md",
        [
          "<!-- TASK:T-3.7.9 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"pro","skill":"orchestration-specialist","parallel_group":"routing-remediation"}} -->',
          "- [ ] **T-3.7.9**: fail closed when configured pool is unresolved.",
        ].join("\n"),
      );

      const client = createMockClient(root);
      const plugin = await createPlugin(client, root);

      await emitEvent(
        plugin,
        sessionCreatedEvent("ses-root-blocked", root, "triage: execute T-3.7.9 from minion_Tasklist.md"),
      );
      await emitEvent(plugin, sessionIdleEvent("ses-root-blocked"));

      const snapshot = await readSnapshot<PipelineFixture>(root);
      const pipeline = snapshot.pipelines["ses-root-blocked"];
      const eventLog = await readEventLog(root);

      assert.equal(pipeline.transition, "blocked");
      assert.equal(pipeline.currentStage, "triage");
      assert.equal(client.creates.length, 0);
      assert.equal(eventLog.some((entry) => entry.type === "task_blocked"), true);
      assert.equal(
        client.prompts.some(
          (entry) =>
            entry.sessionID === "ses-root-blocked" && entry.text.includes("Pipeline is blocked before implementation spawn"),
        ),
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("spec handoff continuation preserves resolved execution target", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-routing-handoff-"));

    try {
      await writeConfig(
        root,
        {
          enabled: true,
          mode: "auto",
          require_approval_before_spawn: false,
          ignore_aborted_messages: true,
          verbose_events: false,
        },
        {
          task_routing: { source: "tasklist_explicit", default_tier: "standard" },
          agent_pools: {
            implementation: {
              standard: ["minion-standard"],
            },
          },
        },
      );
      await writeOpencodeAgentConfig(root, ["planner", "minion", "minion-standard", "reviewer"]);
      await writeSkillCatalog(root, ["spec-expert", "backend-specialist"]);
      await writeSpawnWorktreeScript(root);
      await writeTasklist(
        root,
        "minion_Tasklist.md",
        [
          "<!-- TASK:T-3.7.10 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"standard","parallel_group":"routing-remediation-tests","depends_on":["T-3.7.7","T-3.7.8","T-3.7.9"]}} -->',
          "- [ ] **T-3.7.10**: add runtime regression coverage.",
        ].join("\n"),
      );

      const client = createMockClient(root);
      const plugin = await createPlugin(client, root);

      await emitEvent(
        plugin,
        sessionCreatedEvent(
          "ses-root-handoff",
          root,
          "triage: execute T-3.7.10 from minion_Tasklist.md requirements are unclear and need recommendation",
        ),
      );
      await emitEvent(plugin, sessionIdleEvent("ses-root-handoff"));

      const beforeHandoff = await readSnapshot<PipelineFixture>(root);
      const handoffPipeline = beforeHandoff.pipelines["ses-root-handoff"];
      const markerPath = handoffPipeline.specHandoff?.markerPath;
      assert.equal(typeof markerPath, "string");
      assert.equal(handoffPipeline.specHandoff?.completed, false);
      assert.equal(handoffPipeline.routing?.agentID, "minion-standard");
      assert.equal(handoffPipeline.routing?.role, "implementation");
      assert.equal(handoffPipeline.routing?.tier, "standard");
      assert.equal(handoffPipeline.routing?.taskRef, "T-3.7.10");

      await writeFile(
        markerPath as string,
        [
          "# Spec Handoff",
          "<!-- DEMONLORD_SPEC_HANDOFF_READY -->",
          "## Scope",
          "- implement deterministic routing safeguards",
          "## Constraints",
          "- preserve resolved execution target",
        ].join("\n"),
        "utf-8",
      );

      await emitEvent(plugin, sessionIdleEvent("ses-child-1"));

      const afterHandoff = await readSnapshot<PipelineFixture>(root);
      const resumed = afterHandoff.pipelines["ses-root-handoff"];

      assert.equal(resumed.specHandoff?.completed, true);
      assert.equal(resumed.routing?.skillID, "backend-specialist");
      assert.equal(resumed.routing?.agentID, "minion-standard");
      assert.equal(resumed.routing?.role, "implementation");
      assert.equal(resumed.routing?.tier, "standard");
      assert.equal(resumed.routing?.taskRef, "T-3.7.10");
      assert.equal(client.creates.length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

interface MockClient {
  prompts: Array<{ sessionID: string; text: string }>;
  creates: Array<{ parentID?: string; title?: string }>;
  session: {
    prompt(input: {
      path: { id: string };
      body: { parts: Array<{ type: string; text?: string }> };
      query: { directory: string };
    }): Promise<{ data: {} }>;
    create(input: {
      body: { parentID?: string; title?: string };
      query: { directory: string };
    }): Promise<{ data: Session }>;
    get(input: { path: { id: string } }): Promise<{ data: Session | null }>;
  };
}

function createMockClient(worktree: string): MockClient {
  const sessions = new Map<string, Session>();
  const prompts: Array<{ sessionID: string; text: string }> = [];
  const creates: Array<{ parentID?: string; title?: string }> = [];

  return {
    prompts,
    creates,
    session: {
      async prompt(input) {
        const text = input.body.parts
          .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
          .join("\n");
        prompts.push({ sessionID: input.path.id, text });
        return { data: {} };
      },
      async create(input) {
        creates.push({ parentID: input.body.parentID, title: input.body.title });
        const id = `ses-child-${creates.length}`;
        const created = buildSession(id, input.query.directory, input.body.title ?? id, input.body.parentID);
        sessions.set(id, created);
        return { data: created };
      },
      async get(input) {
        return {
          data: sessions.get(input.path.id) ?? null,
        };
      },
    },
  };
}

async function createPlugin(client: MockClient, root: string): Promise<Awaited<ReturnType<typeof OrchestratorPlugin>>> {
  return OrchestratorPlugin(
    {
      client: client as unknown as Parameters<typeof OrchestratorPlugin>[0]["client"],
      worktree: root,
    } as Parameters<typeof OrchestratorPlugin>[0],
  );
}

async function emitEvent(
  plugin: Awaited<ReturnType<typeof OrchestratorPlugin>>,
  event: Event,
): Promise<void> {
  await plugin.event?.({ event });
}

function buildSession(id: string, directory: string, title: string, parentID?: string): Session {
  return {
    id,
    projectID: "proj-test",
    directory,
    parentID,
    title,
    version: "test",
    time: {
      created: Date.now(),
      updated: Date.now(),
    },
  };
}

function sessionCreatedEvent(id: string, directory: string, title: string, parentID?: string): Event {
  return {
    type: "session.created",
    properties: {
      info: buildSession(id, directory, title, parentID),
    },
  };
}

function commandExecutedEvent(sessionID: string, argumentsText: string): Event {
  return {
    type: "command.executed",
    properties: {
      name: "pipeline",
      sessionID,
      arguments: argumentsText,
      messageID: `msg-${sessionID}`,
    },
  };
}

function sessionIdleEvent(sessionID: string): Event {
  return {
    type: "session.idle",
    properties: { sessionID },
  };
}

function sessionErrorEvent(sessionID: string, message: string): Event {
  return {
    type: "session.error",
    properties: {
      sessionID,
      error: {
        name: "UnknownError",
        data: {
          message,
        },
      },
    },
  };
}

async function writeConfig(
  root: string,
  orchestration: {
    enabled: boolean;
    mode: "off" | "manual" | "auto";
    require_approval_before_spawn: boolean;
    ignore_aborted_messages: boolean;
    verbose_events: boolean;
  },
  overrides?: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    resolve(root, "demonlord.config.json"),
    `${JSON.stringify({ orchestration: { ...orchestration, ...(overrides ?? {}) } }, null, 2)}\n`,
    "utf-8",
  );
}

async function writeOpencodeAgentConfig(root: string, agentIDs: string[]): Promise<void> {
  const agentEntries = Object.fromEntries(
    agentIDs.map((agentID) => [agentID, { mode: "subagent", description: `${agentID} test agent` }]),
  );

  await mkdir(resolve(root, ".opencode"), { recursive: true });
  await writeFile(
    resolve(root, ".opencode", "opencode.jsonc"),
    `${JSON.stringify({ agent: agentEntries }, null, 2)}\n`,
    "utf-8",
  );
}

async function writeTasklist(root: string, fileName: string, content: string): Promise<void> {
  await mkdir(resolve(root, "agents"), { recursive: true });
  await writeFile(resolve(root, "agents", fileName), `${content}\n`, "utf-8");
}

async function writeSkillCatalog(root: string, skillIDs: string[]): Promise<void> {
  const skillsRoot = resolve(root, ".opencode", "skills");
  await mkdir(skillsRoot, { recursive: true });

  for (const skillID of skillIDs) {
    const directory = resolve(skillsRoot, skillID);
    await mkdir(directory, { recursive: true });
    const skillBody = [
      "---",
      `name: ${skillID}`,
      `description: ${skillID} test skill`,
      "---",
      "",
      "## Routing Hints",
      skillID === "spec-expert"
        ? "- ambiguity requirements tasklist recommendation"
        : "- implementation backend api coding",
    ].join("\n");
    await writeFile(resolve(directory, "SKILL.md"), `${skillBody}\n`, "utf-8");
  }
}

async function writeSpawnWorktreeScript(root: string): Promise<void> {
  const toolsRoot = resolve(root, "agents", "tools");
  await mkdir(toolsRoot, { recursive: true });

  const scriptPath = resolve(toolsRoot, "spawn_worktree.sh");
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "task_id=\"${1:-task}\"",
    "worktree_path=\"$PWD/.tmp-worktrees/$task_id\"",
    "mkdir -p \"$worktree_path/_bmad-output\"",
    "printf 'Created worktree: %s\\n' \"$worktree_path\"",
    "printf 'Branch: %s\\n' \"test-$task_id\"",
  ].join("\n");

  await writeFile(scriptPath, `${script}\n`, "utf-8");
  await chmod(scriptPath, 0o755);
}

async function readSnapshot<TPipeline = PipelineFixture>(root: string): Promise<{
  pipelines: Record<string, TPipeline>;
}> {
  const raw = await readFile(resolve(root, "_bmad-output", "orchestration-state.json"), "utf-8");
  const parsed = JSON.parse(raw) as { pipelines: Record<string, TPipeline> };
  return parsed;
}

async function readEventLog(root: string): Promise<Array<{ type: string }>> {
  const filePath = resolve(root, "_bmad-output", "orchestration-events.ndjson");

  try {
    const raw = await readFile(filePath, "utf-8");
    return __orchestratorTestUtils
      .splitCommandQueueLines(raw)
      .map((line) => {
        try {
          return JSON.parse(line) as { type: string };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { type: string } => Boolean(entry));
  } catch {
    return [];
  }
}
