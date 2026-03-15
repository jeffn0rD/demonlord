import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { Event, Session } from "@opencode-ai/sdk";
import OrchestratorPlugin, { __orchestratorTestUtils } from "../../plugins/orchestrator.ts";
import { runPipelineCtl } from "../../../agents/tools/pipelinectl.ts";

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
  details?: Record<string, unknown>;
}

interface ExecutionGraphEventFixture {
  seq: number;
  ts: string;
  rootSessionID: string;
  eventType: string;
  sessionID: string;
  parentSessionID: string;
  stage: PipelineStage;
  taskRef: string;
  agentID: string;
  tier: string;
  skillID: string;
  parallelGroup: string;
  slot: string;
  status: string;
  reason?: string;
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
  nextSessionID?: string;
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

  test("command.execute.before short-circuits /pipeline with no_reply while handling command", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-prehook-no-reply-"));

    try {
      await writeConfig(
        root,
        {
          enabled: true,
          mode: "manual",
          require_approval_before_spawn: true,
          ignore_aborted_messages: true,
          verbose_events: false,
        },
        { pipeline_command_short_circuit: "no_reply" },
      );

      const client = createMockClient(root);
      const plugin = await createPlugin(client, root);

      await emitEvent(plugin, sessionCreatedEvent("ses-prehook-no-reply", root, "triage: prehook no reply"));

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };
      await emitCommandBefore(plugin, {
        command: "pipeline",
        sessionID: "ses-prehook-no-reply",
        arguments: "status",
      }, output);

      assert.equal(output.noReply, true);
      assert.deepEqual(output.parts, []);
      assert.equal(
        client.prompts.some(
          (entry) => entry.sessionID === "ses-prehook-no-reply" && entry.text.includes("Pipeline: ses-prehook-no-reply"),
        ),
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("command.execute.before prehook_error throws after command handling without recovery side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-prehook-error-"));

    try {
      await writeConfig(
        root,
        {
          enabled: true,
          mode: "manual",
          require_approval_before_spawn: true,
          ignore_aborted_messages: true,
          verbose_events: false,
        },
        { pipeline_command_short_circuit: "prehook_error" },
      );

      const client = createMockClient(root);
      const plugin = await createPlugin(client, root);

      await emitEvent(plugin, sessionCreatedEvent("ses-prehook-error", root, "triage: prehook error"));

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };
      await assert.rejects(
        () =>
          emitCommandBefore(
            plugin,
            {
              command: "pipeline",
              sessionID: "ses-prehook-error",
              arguments: "status",
            },
            output,
          ),
        /strategy=prehook_error/i,
      );

      assert.deepEqual(output.parts, []);
      assert.equal(output.noReply, undefined);
      assert.equal(
        client.prompts.some((entry) => entry.sessionID === "ses-prehook-error" && entry.text.includes("Pipeline: ses-prehook-error")),
        true,
      );

      await emitEvent(
        plugin,
        sessionErrorEvent("ses-prehook-error", {
          name: "PipelineControlPrehookStopError",
          code: "DEMONLORD_PIPELINE_PREHOOK_STOP",
          message: "intentional halt",
        }),
      );

      const snapshot = await readSnapshot<PipelineFixture>(root);
      const pipeline = snapshot.pipelines["ses-prehook-error"];
      const events = await readEventLog(root);

      assert.equal(pipeline.error.attempts, 0);
      assert.equal(pipeline.error.handledSignatures.length, 0);
      assert.equal(events.filter((entry) => entry.type === "error_ignored").length, 1);
      assert.equal(events.filter((entry) => entry.type === "error").length, 0);
      assert.equal(client.prompts.filter((entry) => entry.text.includes("Recovery attempt")).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("command.execute.before intercepts /run-review, bypasses reasoning turn, and persists review artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-run-review-prehook-"));

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

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      await emitCommandBefore(
        plugin,
        {
          command: "run-review",
          sessionID: "ses-run-review",
          arguments: 'creview beelzebub 1.5 "focus deterministic routing"',
        },
        output,
      );

      assert.equal(output.noReply, true);
      assert.deepEqual(output.parts, []);
      assert.equal(client.commands.some((entry) => entry.command === "run-review"), false);
      assert.equal(client.commands.filter((entry) => entry.command === "creview").length, 1);

      const reviewDirectory = resolve(root, "_bmad-output", "cycle-state", "reviews");
      const artifacts = await readdir(reviewDirectory);
      const artifactName = artifacts.find((entry) => entry.startsWith("beelzebub-phase-1-subphase-1-5-round-"));
      assert.equal(typeof artifactName, "string");

      const artifactRaw = await readFile(resolve(reviewDirectory, artifactName as string), "utf-8");
      const artifact = JSON.parse(artifactRaw) as {
        review_type: string;
        marker_found: boolean;
        review_status: string;
      };
      assert.equal(artifact.review_type, "creview");
      assert.equal(artifact.marker_found, true);
      assert.equal(artifact.review_status, "pass");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("run-review prehook persists artifacts when marker is only available via session.messages fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-run-review-message-fallback-"));

    try {
      await writeConfig(root, {
        enabled: true,
        mode: "manual",
        require_approval_before_spawn: true,
        ignore_aborted_messages: true,
        verbose_events: false,
      });

      const client = createMockClient(root, { runReviewMarkerInMessages: true });
      const plugin = await createPlugin(client, root);

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      await emitCommandBefore(
        plugin,
        {
          command: "run-review",
          sessionID: "ses-run-review-fallback",
          arguments: 'creview beelzebub 1.5 "focus deterministic routing"',
        },
        output,
      );

      assert.equal(output.noReply, true);
      assert.deepEqual(output.parts, []);
      assert.equal(client.commands.some((entry) => entry.command === "run-review"), false);
      assert.equal(client.commands.filter((entry) => entry.command === "creview").length, 1);
      assert.equal(client.messagePolls.length > 0, true);

      const reviewDirectory = resolve(root, "_bmad-output", "cycle-state", "reviews");
      const artifacts = await readdir(reviewDirectory);
      const artifactName = artifacts.find((entry) => entry.startsWith("beelzebub-phase-1-subphase-1-5-round-"));
      assert.equal(typeof artifactName, "string");

      const artifactRaw = await readFile(resolve(reviewDirectory, artifactName as string), "utf-8");
      const artifact = JSON.parse(artifactRaw) as {
        review_type: string;
        marker_found: boolean;
        review_status: string;
      };
      assert.equal(artifact.review_type, "creview");
      assert.equal(artifact.marker_found, true);
      assert.equal(artifact.review_status, "pass");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("direct /creview, /mreview, and /phreview remain callable and are not prehook-blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-direct-review-commands-"));

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

      const commands: Array<{ command: string; arguments: string }> = [
        { command: "creview", arguments: "beelzebub 1.5" },
        { command: "mreview", arguments: "README.md" },
        { command: "phreview", arguments: "beelzebub 1" },
      ];

      for (const candidate of commands) {
        const output: { parts: unknown[]; noReply?: boolean } = {
          parts: [{ type: "text", text: "placeholder" }],
        };
        await emitCommandBefore(
          plugin,
          {
            command: candidate.command,
            sessionID: "ses-direct-review",
            arguments: candidate.arguments,
          },
          output,
        );

        assert.equal(output.noReply, undefined);
        assert.deepEqual(output.parts, [{ type: "text", text: "placeholder" }]);
      }

      assert.equal(client.commands.length, 0);
      assert.equal(client.prompts.length, 0);
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

  test("uses persisted traversal context for metadata routing when title lacks task token", async () => {
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
          "<!-- TASK:T-3.7.3 -->",
          "- [x] **T-3.7.3**: prerequisite completed in prior subphase.",
          "<!-- TASK:T-3.7.7 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"pro","skill":"orchestration-specialist","parallel_group":"routing-remediation","depends_on":["T-3.7.3"]}} -->',
          "- [ ] **T-3.7.7**: preserve execution target across spec handoff.",
        ].join("\n"),
      );
      const tasklistPath = resolve(root, "agents", "minion_Tasklist.md");

      const client = createMockClient(root);
      const initialPlugin = await createPlugin(client, root);

      await emitEvent(
        initialPlugin,
        sessionCreatedEvent("ses-root-explicit", root, "triage: route selected remediation task"),
      );
      await seedTaskTraversalContext(root, "ses-root-explicit", {
        taskDescription: "selected remediation task",
        taskRef: "T-3.7.7",
        tasklistPath,
      });
      const plugin = await createPlugin(client, root);
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

  test("emits warning-level fallback when persisted task lacks EXECUTION metadata", async () => {
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
      const tasklistPath = resolve(root, "agents", "minion_Tasklist.md");

      const client = createMockClient(root);
      const initialPlugin = await createPlugin(client, root);

      await emitEvent(
        initialPlugin,
        sessionCreatedEvent(
          "ses-root-warning",
          root,
          "triage: deterministic fallback for selected task",
        ),
      );
      await seedTaskTraversalContext(root, "ses-root-warning", {
        taskDescription: "selected fallback task",
        taskRef: "T-3.7.8",
        tasklistPath,
      });
      const plugin = await createPlugin(client, root);
      await emitEvent(plugin, sessionIdleEvent("ses-root-warning"));

      const snapshot = await readSnapshot<PipelineFixture>(root);
      const pipeline = snapshot.pipelines["ses-root-warning"];
      const eventLog = await readEventLog(root);
      const warningEvent = eventLog.find((entry) => entry.type === "routing_warning");

      assert.equal(pipeline.routing?.metadataSource, "legacy");
      assert.equal(pipeline.routing?.taskRef, "T-3.7.8");
      assert.equal(Boolean(warningEvent), true);
      assert.match(String(warningEvent?.details?.reason ?? ""), /Missing EXECUTION metadata/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("blocks deterministic routing when persisted task tier pool is unresolved", async () => {
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
      const tasklistPath = resolve(root, "agents", "minion_Tasklist.md");

      const client = createMockClient(root);
      const initialPlugin = await createPlugin(client, root);

      await emitEvent(
        initialPlugin,
        sessionCreatedEvent("ses-root-blocked", root, "triage: blocked routing selection"),
      );
      await seedTaskTraversalContext(root, "ses-root-blocked", {
        taskDescription: "blocked routing selection",
        taskRef: "T-3.7.9",
        tasklistPath,
      });
      const plugin = await createPlugin(client, root);
      await emitEvent(plugin, sessionIdleEvent("ses-root-blocked"));

      const snapshot = await readSnapshot<PipelineFixture>(root);
      const pipeline = snapshot.pipelines["ses-root-blocked"];
      const eventLog = await readEventLog(root);
      const blockedEvent = eventLog.find((entry) => entry.type === "task_blocked");

      assert.equal(pipeline.transition, "blocked");
      assert.equal(pipeline.currentStage, "triage");
      assert.equal(client.creates.length, 0);
      assert.equal(Boolean(blockedEvent), true);
      assert.match(String(blockedEvent?.details?.reason ?? ""), /no configured agent/i);
      assert.match(String(blockedEvent?.details?.reason ?? ""), /legacy 'minion'/i);
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

  test("blocks implementation dispatch when depends_on prerequisites are unresolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-dependency-block-"));

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
      await writeTasklist(
        root,
        "minion_Tasklist.md",
        [
          "<!-- TASK:T-3.9.0 -->",
          "- [ ] **T-3.9.0**: prerequisite intentionally incomplete.",
          "<!-- TASK:T-3.9.3 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"standard","skill":"orchestration-specialist","parallel_group":"tests-dispatch","depends_on":["T-3.9.0"]}} -->',
          "- [ ] **T-3.9.3**: verify dependency gating.",
        ].join("\n"),
      );
      const tasklistPath = resolve(root, "agents", "minion_Tasklist.md");

      const client = createMockClient(root);
      const initialPlugin = await createPlugin(client, root);

      await emitEvent(initialPlugin, sessionCreatedEvent("ses-root-deps", root, "triage: dependency gate"));
      await seedTaskTraversalContext(root, "ses-root-deps", {
        taskDescription: "dependency gate",
        taskRef: "T-3.9.3",
        tasklistPath,
      });

      const plugin = await createPlugin(client, root);
      await emitEvent(plugin, sessionIdleEvent("ses-root-deps"));

      const snapshot = await readSnapshot<PipelineFixture>(root);
      const pipeline = snapshot.pipelines["ses-root-deps"];
      const eventLog = await readEventLog(root);
      const blockedEvent = eventLog.find((entry) => entry.type === "task_blocked");
      const graph = await readExecutionGraph(root, "ses-root-deps");
      const graphBlocked = graph.find((entry) => entry.eventType === "task_blocked");

      assert.equal(pipeline.transition, "blocked");
      assert.equal(pipeline.currentStage, "triage");
      assert.equal(client.creates.length, 0);
      assert.match(String(blockedEvent?.details?.reason ?? ""), /depends_on unresolved/i);
      assert.match(String(blockedEvent?.details?.reason ?? ""), /T-3\.9\.0/i);
      assert.match(String(graphBlocked?.reason ?? ""), /depends_on unresolved/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("queues on parallel caps and resumes queued pipelines deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-parallel-queue-"));

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
            review: {
              standard: ["reviewer"],
            },
          },
          parallelism: {
            max_parallel_total: 1,
            max_parallel_by_role: {
              planning: 1,
              implementation: 1,
              review: 1,
            },
            max_parallel_by_tier: {
              lite: 1,
              standard: 1,
              pro: 1,
            },
          },
        },
      );
      await writeOpencodeAgentConfig(root, ["planner", "minion", "minion-standard", "reviewer"]);
      await writeSpawnWorktreeScript(root);
      await writeTasklist(
        root,
        "minion_Tasklist.md",
        [
          "<!-- TASK:T-3.9.31 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"standard","skill":"orchestration-specialist","parallel_group":"tests-dispatch"}} -->',
          "- [ ] **T-3.9.31**: first queued pipeline.",
          "<!-- TASK:T-3.9.32 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"standard","skill":"orchestration-specialist","parallel_group":"tests-dispatch"}} -->',
          "- [ ] **T-3.9.32**: second queued pipeline.",
          "<!-- TASK:T-3.9.33 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"standard","skill":"orchestration-specialist","parallel_group":"tests-dispatch"}} -->',
          "- [ ] **T-3.9.33**: third queued pipeline.",
        ].join("\n"),
      );
      const tasklistPath = resolve(root, "agents", "minion_Tasklist.md");

      const client = createMockClient(root);
      const initialPlugin = await createPlugin(client, root);

      await emitEvent(initialPlugin, sessionCreatedEvent("ses-root-cap-a", root, "triage: cap A"));
      await emitEvent(initialPlugin, sessionCreatedEvent("ses-root-cap-b", root, "triage: cap B"));
      await emitEvent(initialPlugin, sessionCreatedEvent("ses-root-cap-c", root, "triage: cap C"));

      await seedTaskTraversalContext(root, "ses-root-cap-a", {
        taskDescription: "cap A",
        taskRef: "T-3.9.31",
        tasklistPath,
      });
      await seedTaskTraversalContext(root, "ses-root-cap-b", {
        taskDescription: "cap B",
        taskRef: "T-3.9.32",
        tasklistPath,
      });
      await seedTaskTraversalContext(root, "ses-root-cap-c", {
        taskDescription: "cap C",
        taskRef: "T-3.9.33",
        tasklistPath,
      });

      const plugin = await createPlugin(client, root);
      await emitEvent(plugin, sessionIdleEvent("ses-root-cap-a"));
      await emitEvent(plugin, sessionIdleEvent("ses-root-cap-b"));
      await emitEvent(plugin, sessionIdleEvent("ses-root-cap-c"));

      const queuedSnapshot = await readSnapshot<PipelineFixture>(root);
      const queuePipelineB = queuedSnapshot.pipelines["ses-root-cap-b"];
      const queuePipelineC = queuedSnapshot.pipelines["ses-root-cap-c"];
      const graphBQueued = await readExecutionGraph(root, "ses-root-cap-b");
      const graphCQueued = await readExecutionGraph(root, "ses-root-cap-c");

      assert.equal(queuePipelineB.transition, "idle");
      assert.equal(queuePipelineB.currentStage, "triage");
      assert.equal(queuePipelineC.transition, "idle");
      assert.equal(queuePipelineC.currentStage, "triage");
      assert.equal(graphBQueued.filter((entry) => entry.eventType === "task_queued").length, 1);
      assert.equal(graphCQueued.filter((entry) => entry.eventType === "task_queued").length, 1);
      assert.equal(
        client.prompts.some((entry) => entry.text.includes("remains queued: global parallel cap reached")),
        true,
      );

      const pipelineAImplSessionID = queuedSnapshot.pipelines["ses-root-cap-a"]?.nextSessionID;
      assert.equal(typeof pipelineAImplSessionID, "string");
      await emitEvent(plugin, sessionIdleEvent(pipelineAImplSessionID as string));

      const resumedBSnapshot = await readSnapshot<PipelineFixture>(root);
      const pipelineBImplSessionID = resumedBSnapshot.pipelines["ses-root-cap-b"]?.nextSessionID;

      assert.equal(resumedBSnapshot.pipelines["ses-root-cap-b"]?.currentStage, "implementation");
      assert.equal(typeof pipelineBImplSessionID, "string");

      await emitEvent(plugin, sessionIdleEvent("ses-root-cap-c"));
      const stillQueuedSnapshot = await readSnapshot<PipelineFixture>(root);
      assert.equal(stillQueuedSnapshot.pipelines["ses-root-cap-c"]?.currentStage, "triage");
      assert.equal(stillQueuedSnapshot.pipelines["ses-root-cap-c"]?.transition, "idle");

      await emitEvent(plugin, sessionIdleEvent(pipelineBImplSessionID as string));

      const resumedCSnapshot = await readSnapshot<PipelineFixture>(root);
      const pipelineCImplSessionID = resumedCSnapshot.pipelines["ses-root-cap-c"]?.nextSessionID;

      assert.equal(resumedCSnapshot.pipelines["ses-root-cap-c"]?.currentStage, "implementation");
      assert.equal(typeof pipelineCImplSessionID, "string");

      const pipelineBImplOrder = extractSessionOrdinal(pipelineBImplSessionID as string);
      const pipelineCImplOrder = extractSessionOrdinal(pipelineCImplSessionID as string);
      assert.equal(Number.isFinite(pipelineBImplOrder), true);
      assert.equal(Number.isFinite(pipelineCImplOrder), true);
      assert.equal(pipelineBImplOrder < pipelineCImplOrder, true);

      const graphCAfterResume = await readExecutionGraph(root, "ses-root-cap-c");
      assert.equal(graphCAfterResume.filter((entry) => entry.eventType === "task_queued").length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("validates execution-graph schema, ordering, and duplicate suppression", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-execution-graph-"));

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
            review: {
              standard: ["reviewer"],
            },
          },
        },
      );
      await writeOpencodeAgentConfig(root, ["planner", "minion", "minion-standard", "reviewer"]);
      await writeSpawnWorktreeScript(root);
      await writeTasklist(
        root,
        "minion_Tasklist.md",
        [
          "<!-- TASK:T-3.9.41 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"standard","skill":"orchestration-specialist","parallel_group":"tests-graph"}} -->',
          "- [ ] **T-3.9.41**: execution graph contract validation.",
        ].join("\n"),
      );
      const tasklistPath = resolve(root, "agents", "minion_Tasklist.md");

      const client = createMockClient(root);
      const initialPlugin = await createPlugin(client, root);

      await emitEvent(initialPlugin, sessionCreatedEvent("ses-root-graph", root, "triage: graph contract"));
      await seedTaskTraversalContext(root, "ses-root-graph", {
        taskDescription: "graph contract",
        taskRef: "T-3.9.41",
        tasklistPath,
      });

      const plugin = await createPlugin(client, root);
      await emitEvent(plugin, sessionIdleEvent("ses-root-graph"));
      await emitEvent(plugin, sessionIdleEvent("ses-root-graph"));

      const afterImplementationSpawn = await readSnapshot<PipelineFixture>(root);
      const implementationSessionID = afterImplementationSpawn.pipelines["ses-root-graph"]?.nextSessionID;
      assert.equal(typeof implementationSessionID, "string");

      await emitEvent(plugin, sessionIdleEvent(implementationSessionID as string));

      const afterReviewSpawn = await readSnapshot<PipelineFixture>(root);
      const reviewSessionID = afterReviewSpawn.pipelines["ses-root-graph"]?.nextSessionID;
      assert.equal(typeof reviewSessionID, "string");

      await emitEvent(plugin, sessionIdleEvent(reviewSessionID as string));
      await emitEvent(plugin, sessionIdleEvent(reviewSessionID as string));

      const graph = await readExecutionGraph(root, "ses-root-graph");
      assert.equal(graph.length > 0, true);

      for (const entry of graph) {
        assert.equal(typeof entry.seq, "number");
        assert.equal(typeof entry.ts, "string");
        assert.equal(typeof entry.rootSessionID, "string");
        assert.equal(typeof entry.eventType, "string");
        assert.equal(typeof entry.sessionID, "string");
        assert.equal(typeof entry.parentSessionID, "string");
        assert.equal(typeof entry.stage, "string");
        assert.equal(typeof entry.taskRef, "string");
        assert.equal(typeof entry.agentID, "string");
        assert.equal(typeof entry.tier, "string");
        assert.equal(typeof entry.skillID, "string");
        assert.equal(typeof entry.parallelGroup, "string");
        assert.equal(typeof entry.slot, "string");
        assert.equal(typeof entry.status, "string");
      }

      for (let index = 0; index < graph.length; index += 1) {
        assert.equal(graph[index]?.seq, index + 1);
      }

      const lifecycleIndex = (eventType: string): number => graph.findIndex((entry) => entry.eventType === eventType);
      assert.equal(lifecycleIndex("pipeline_started") >= 0, true);
      assert.equal(lifecycleIndex("task_queued") >= 0, true);
      assert.equal(lifecycleIndex("spawn_requested") > lifecycleIndex("task_queued"), true);
      assert.equal(lifecycleIndex("spawn_started") > lifecycleIndex("spawn_requested"), true);
      assert.equal(lifecycleIndex("spawn_completed") > lifecycleIndex("spawn_started"), true);
      assert.equal(lifecycleIndex("task_completed") > lifecycleIndex("spawn_completed"), true);
      assert.equal(lifecycleIndex("pipeline_completed") > lifecycleIndex("task_completed"), true);

      const queuedForTask = graph.filter(
        (entry) => entry.eventType === "task_queued" && entry.taskRef.toUpperCase() === "T-3.9.41",
      );
      const terminalEvents = graph.filter((entry) => entry.eventType === "pipeline_completed");
      assert.equal(queuedForTask.length, 1);
      assert.equal(terminalEvents.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("respects execution_graph.path for graph writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-execution-graph-path-"));

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
            review: {
              standard: ["reviewer"],
            },
          },
          execution_graph: {
            enabled: true,
            path: "_bmad-output/custom-execution-graph.ndjson",
            verbosity: "concise",
          },
        },
      );
      await writeOpencodeAgentConfig(root, ["planner", "minion", "minion-standard", "reviewer"]);
      await writeSpawnWorktreeScript(root);
      await writeTasklist(
        root,
        "minion_Tasklist.md",
        [
          "<!-- TASK:T-3.9.51 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"standard","skill":"orchestration-specialist","parallel_group":"tests-graph"}} -->',
          "- [ ] **T-3.9.51**: execution graph custom path validation.",
        ].join("\n"),
      );
      const tasklistPath = resolve(root, "agents", "minion_Tasklist.md");

      const client = createMockClient(root);
      const initialPlugin = await createPlugin(client, root);
      await emitEvent(initialPlugin, sessionCreatedEvent("ses-root-graph-path", root, "triage: graph path"));
      await seedTaskTraversalContext(root, "ses-root-graph-path", {
        taskDescription: "graph path",
        taskRef: "T-3.9.51",
        tasklistPath,
      });

      const plugin = await createPlugin(client, root);
      await emitEvent(plugin, sessionIdleEvent("ses-root-graph-path"));

      const customGraph = await readExecutionGraph(root, "ses-root-graph-path", "_bmad-output/custom-execution-graph.ndjson");
      const defaultGraph = await readExecutionGraph(root, "ses-root-graph-path");

      assert.equal(customGraph.length > 0, true);
      assert.equal(defaultGraph.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("respects execution_graph.enabled=false and skips graph writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-execution-graph-disabled-"));

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
            review: {
              standard: ["reviewer"],
            },
          },
          execution_graph: {
            enabled: false,
            path: "_bmad-output/disabled-execution-graph.ndjson",
            verbosity: "concise",
          },
        },
      );
      await writeOpencodeAgentConfig(root, ["planner", "minion", "minion-standard", "reviewer"]);
      await writeSpawnWorktreeScript(root);
      await writeTasklist(
        root,
        "minion_Tasklist.md",
        [
          "<!-- TASK:T-3.9.52 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"standard","skill":"orchestration-specialist","parallel_group":"tests-graph"}} -->',
          "- [ ] **T-3.9.52**: execution graph disabled validation.",
        ].join("\n"),
      );
      const tasklistPath = resolve(root, "agents", "minion_Tasklist.md");

      const client = createMockClient(root);
      const initialPlugin = await createPlugin(client, root);
      await emitEvent(initialPlugin, sessionCreatedEvent("ses-root-graph-disabled", root, "triage: graph disabled"));
      await seedTaskTraversalContext(root, "ses-root-graph-disabled", {
        taskDescription: "graph disabled",
        taskRef: "T-3.9.52",
        tasklistPath,
      });

      const plugin = await createPlugin(client, root);
      await emitEvent(plugin, sessionIdleEvent("ses-root-graph-disabled"));

      const disabledGraph = await readExecutionGraph(
        root,
        "ses-root-graph-disabled",
        "_bmad-output/disabled-execution-graph.ndjson",
      );
      assert.equal(disabledGraph.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("spec handoff continuation preserves resolved execution target from persisted context", async () => {
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
          "<!-- TASK:T-3.7.7 -->",
          "- [x] **T-3.7.7**: prerequisite complete.",
          "<!-- TASK:T-3.7.8 -->",
          "- [x] **T-3.7.8**: prerequisite complete.",
          "<!-- TASK:T-3.7.9 -->",
          "- [x] **T-3.7.9**: prerequisite complete.",
          "<!-- TASK:T-3.7.10 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"standard","parallel_group":"routing-remediation-tests","depends_on":["T-3.7.7","T-3.7.8","T-3.7.9"]}} -->',
          "- [ ] **T-3.7.10**: add runtime regression coverage.",
        ].join("\n"),
      );
      const tasklistPath = resolve(root, "agents", "minion_Tasklist.md");

      const client = createMockClient(root);
      const initialPlugin = await createPlugin(client, root);

      await emitEvent(
        initialPlugin,
        sessionCreatedEvent(
          "ses-root-handoff",
          root,
          "triage: requirements are unclear and need recommendation",
        ),
      );
      await seedTaskTraversalContext(root, "ses-root-handoff", {
        taskDescription: "requirements are unclear and need recommendation",
        taskRef: "T-3.7.10",
        tasklistPath,
      });
      const plugin = await createPlugin(client, root);
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

  test("fails closed before review spawn when configured agent catalog is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-review-fail-closed-"));

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
            review: {
              standard: ["reviewer"],
            },
          },
        },
      );
      await writeOpencodeAgentConfig(root, ["planner", "minion", "minion-standard", "reviewer"]);
      await writeSpawnWorktreeScript(root);
      await writeTasklist(
        root,
        "minion_Tasklist.md",
        [
          "<!-- TASK:T-3.7.10 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"standard","skill":"orchestration-specialist","parallel_group":"routing-remediation-tests"}} -->',
          "- [ ] **T-3.7.10**: add runtime regression coverage.",
        ].join("\n"),
      );
      const tasklistPath = resolve(root, "agents", "minion_Tasklist.md");

      const initialClient = createMockClient(root);
      const initialPlugin = await createPlugin(initialClient, root);

      await emitEvent(
        initialPlugin,
        sessionCreatedEvent("ses-root-review-block", root, "triage: selected task without title task token"),
      );
      await seedTaskTraversalContext(root, "ses-root-review-block", {
        taskDescription: "selected review transition task",
        taskRef: "T-3.7.10",
        tasklistPath,
      });
      const seededPlugin = await createPlugin(initialClient, root);
      await emitEvent(seededPlugin, sessionIdleEvent("ses-root-review-block"));

      const beforeReload = await readSnapshot<PipelineFixture>(root);
      assert.equal(beforeReload.pipelines["ses-root-review-block"]?.currentStage, "implementation");
      assert.equal(initialClient.creates.length, 1);

      await writeFile(resolve(root, ".opencode", "opencode.jsonc"), "{\n  // malformed jsonc\n  \"agent\": {\n", "utf-8");

      const resumedClient = createMockClient(root);
      const resumedPlugin = await createPlugin(resumedClient, root);
      await emitEvent(resumedPlugin, sessionIdleEvent("ses-child-1"));

      const snapshot = await readSnapshot<PipelineFixture>(root);
      const pipeline = snapshot.pipelines["ses-root-review-block"];
      const eventLog = await readEventLog(root);

      assert.equal(pipeline.transition, "blocked");
      assert.equal(pipeline.currentStage, "implementation");
      assert.equal(resumedClient.creates.length, 0);
      assert.equal(eventLog.some((entry) => entry.type === "task_blocked"), true);
      assert.equal(
        resumedClient.prompts.some(
          (entry) =>
            entry.sessionID === "ses-root-review-block" && entry.text.includes("Pipeline is blocked before review spawn"),
        ),
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("status output keeps dispatch-view parity with pipelinectl", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-status-parity-"));

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
      await writeSpawnWorktreeScript(root);
      await writeTasklist(
        root,
        "minion_Tasklist.md",
        [
          "<!-- TASK:T-3.9.61 -->",
          '<!-- EXECUTION:{"execution":{"role":"implementation","tier":"standard","skill":"orchestration-specialist","parallel_group":"status-parity"}} -->',
          "- [ ] **T-3.9.61**: status parity validation.",
        ].join("\n"),
      );
      const tasklistPath = resolve(root, "agents", "minion_Tasklist.md");

      const client = createMockClient(root);
      const initialPlugin = await createPlugin(client, root);
      await emitEvent(initialPlugin, sessionCreatedEvent("ses-root-status", root, "triage: parity check"));
      await seedTaskTraversalContext(root, "ses-root-status", {
        taskDescription: "status parity",
        taskRef: "T-3.9.61",
        tasklistPath,
      });

      const plugin = await createPlugin(client, root);
      await emitEvent(plugin, sessionIdleEvent("ses-root-status"));
      await emitEvent(plugin, commandExecutedEvent("ses-root-status", "status"));

      const pipelineStatus = client.prompts.find(
        (entry) => entry.sessionID === "ses-root-status" && entry.text.startsWith("Pipeline:"),
      )?.text;
      assert.equal(typeof pipelineStatus, "string");

      const capture = createCaptureIO();
      const exitCode = await runPipelineCtl(
        ["status", "ses-root-status"],
        {
          OPENCODE_WORKTREE: root,
          OPENCODE_ORCHESTRATION_STATE: resolve(root, "_bmad-output", "orchestration-state.json"),
          OPENCODE_ORCHESTRATION_COMMAND_QUEUE: resolve(root, "_bmad-output", "orchestration-commands.ndjson"),
          OPENCODE_SESSION_ID: "ses-root-status",
        },
        capture.io,
      );
      assert.equal(exitCode, 0);
      const ctlStatus = capture.stdout.join("");

      const sections: Array<"Session Tree:" | "Execution Order:" | "Overlap Windows:"> = [
        "Session Tree:",
        "Execution Order:",
        "Overlap Windows:",
      ];
      for (const section of sections) {
        const pipelineSection = extractStatusSection(pipelineStatus as string, section);
        const ctlSection = extractStatusSection(ctlStatus, section);
        assert.deepEqual(ctlSection, pipelineSection);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

interface MockClient {
  prompts: Array<{ sessionID: string; text: string }>;
  creates: Array<{ parentID?: string; title?: string }>;
  commands: Array<{ sessionID: string; command: string; arguments: string; agent?: string }>;
  deletes: string[];
  messagePolls: Array<{ sessionID: string }>;
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
    command(input: {
      path: { id: string };
      body: { command: string; arguments: string; agent?: string };
      query: { directory: string };
    }): Promise<{ data: { parts: Array<{ type: string; text?: string }> } }>;
    messages(input: {
      path: { id: string };
      query: { directory: string };
    }): Promise<{ data: Array<{ parts: Array<{ type: string; text?: string }> }> }>;
    delete(input: {
      path: { id: string };
      query: { directory: string };
    }): Promise<{ data: {} }>;
    get(input: { path: { id: string } }): Promise<{ data: Session | null }>;
  };
}

interface MockClientOptions {
  runReviewMarkerInMessages?: boolean;
}

function createMockClient(worktree: string, options: MockClientOptions = {}): MockClient {
  const sessions = new Map<string, Session>();
  const prompts: Array<{ sessionID: string; text: string }> = [];
  const creates: Array<{ parentID?: string; title?: string }> = [];
  const commands: Array<{ sessionID: string; command: string; arguments: string; agent?: string }> = [];
  const deletes: string[] = [];
  const messagePolls: Array<{ sessionID: string }> = [];
  const messagePayloadBySession = new Map<string, Array<{ parts: Array<{ type: string; text?: string }> }>>();

  const sessionApi: MockClient["session"] & { _client: { worktree: string } } = {
    _client: { worktree },
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
    async command(input) {
      commands.push({
        sessionID: input.path.id,
        command: input.body.command,
        arguments: input.body.arguments,
        agent: input.body.agent,
      });

      const markerOutput = markerForCommand(input.body.command, input.body.arguments);
      const normalizedCommand = input.body.command.trim().replace(/^\//, "").toLowerCase();
      if (options.runReviewMarkerInMessages === true && normalizedCommand === "creview") {
        messagePayloadBySession.set(input.path.id, [{ parts: [{ type: "text", text: markerOutput }] }]);
        return {
          data: {
            parts: [],
          },
        };
      }

      return {
        data: {
          parts: [
            {
              type: "text",
              text: markerOutput,
            },
          ],
        },
      };
    },
    async messages(
      this: { _client?: { worktree: string } },
      input,
    ) {
      if (!this || !this._client) {
        throw new TypeError("undefined is not an object (evaluating 'this._client')");
      }

      messagePolls.push({ sessionID: input.path.id });
      return {
        data: messagePayloadBySession.get(input.path.id) ?? [],
      };
    },
    async delete(input) {
      deletes.push(input.path.id);
      sessions.delete(input.path.id);
      messagePayloadBySession.delete(input.path.id);
      return { data: {} };
    },
    async get(input) {
      return {
        data: sessions.get(input.path.id) ?? null,
      };
    },
  };

  return {
    prompts,
    creates,
    commands,
    deletes,
    messagePolls,
    session: sessionApi,
  };
}

function markerForCommand(command: string, argumentString: string): string {
  const normalized = command.trim().replace(/^\//, "").toLowerCase();
  const markerName =
    normalized === "creview"
      ? "CYCLE_CREVIEW_RESULT"
      : normalized === "mreview"
        ? "CYCLE_MREVIEW_RESULT"
        : normalized === "phreview"
          ? "CYCLE_PHREVIEW_RESULT"
          : `CYCLE_${normalized.toUpperCase().replace(/-/g, "_")}_RESULT`;
  const payload = {
    status: "pass",
    command: normalized,
    arguments: argumentString,
  };
  return `<!-- ${markerName}\n${JSON.stringify(payload)}\n-->`;
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

async function emitCommandBefore(
  plugin: Awaited<ReturnType<typeof OrchestratorPlugin>>,
  input: { command: string; sessionID: string; arguments: string },
  output: { parts: unknown[]; noReply?: boolean },
): Promise<void> {
  const hook = plugin["command.execute.before"];
  if (!hook) {
    return;
  }

  await hook(input as Parameters<typeof hook>[0], output as Parameters<typeof hook>[1]);
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

function extractSessionOrdinal(sessionID: string): number {
  const pieces = sessionID.split("-");
  const candidate = pieces.length > 0 ? pieces[pieces.length - 1] : "";
  const parsed = Number.parseInt(candidate ?? "", 10);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function createCaptureIO(): {
  stdout: string[];
  stderr: string[];
  io: {
    stdout(message: string): void;
    stderr(message: string): void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout(message: string) {
        stdout.push(message);
      },
      stderr(message: string) {
        stderr.push(message);
      },
    },
  };
}

function extractStatusSection(
  snapshot: string,
  section: "Session Tree:" | "Execution Order:" | "Overlap Windows:",
): string[] {
  const lines = snapshot.split("\n");
  const start = lines.indexOf(section);
  if (start < 0) {
    return [];
  }

  const knownHeaders = new Set(["Session Tree:", "Execution Order:", "Overlap Windows:"]);
  const collected: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (knownHeaders.has(line as "Session Tree:" | "Execution Order:" | "Overlap Windows:")) {
      break;
    }

    collected.push(line);
  }

  while (collected.length > 0 && collected[collected.length - 1]?.trim() === "") {
    collected.pop();
  }

  return collected;
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

function sessionErrorEvent(
  sessionID: string,
  error:
    | string
    | {
      name?: string;
      code?: string;
      message?: string;
    },
): Event {
  const normalizedError =
    typeof error === "string"
      ? {
        name: "UnknownError",
        data: {
          message: error,
        },
      }
      : {
        name: error.name ?? "UnknownError",
        ...(typeof error.code === "string" ? { code: error.code } : {}),
        data: {
          message: error.message ?? "unknown error",
        },
      };

  return {
    type: "session.error",
    properties: {
      sessionID,
      error: normalizedError,
    },
  } as Event;
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

async function seedTaskTraversalContext(
  root: string,
  rootSessionID: string,
  context: { taskDescription: string; taskRef: string; tasklistPath: string },
): Promise<void> {
  const statePath = resolve(root, "_bmad-output", "orchestration-state.json");
  const raw = await readFile(statePath, "utf-8");
  const parsed = JSON.parse(raw) as {
    pipelines?: Record<
      string,
      {
        taskTraversal?: {
          taskDescription?: string;
          taskRef?: string;
          tasklistPath?: string;
        };
      }
    >;
  };

  const pipeline = parsed.pipelines?.[rootSessionID];
  if (!pipeline) {
    throw new Error(`Missing pipeline '${rootSessionID}' while seeding traversal context.`);
  }

  pipeline.taskTraversal = {
    taskDescription: context.taskDescription,
    taskRef: context.taskRef,
    tasklistPath: context.tasklistPath,
  };

  await writeFile(statePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

async function readEventLog(root: string): Promise<OrchestrationEventFixture[]> {
  const filePath = resolve(root, "_bmad-output", "orchestration-events.ndjson");

  try {
    const raw = await readFile(filePath, "utf-8");
    const entries: OrchestrationEventFixture[] = [];
    for (const line of __orchestratorTestUtils.splitCommandQueueLines(raw)) {
      try {
        const parsed = JSON.parse(line) as Partial<OrchestrationEventFixture>;
        if (
          typeof parsed.type !== "string" ||
          typeof parsed.at !== "string" ||
          typeof parsed.rootSessionID !== "string" ||
          typeof parsed.sessionID !== "string" ||
          (parsed.stage !== "triage" && parsed.stage !== "implementation" && parsed.stage !== "review")
        ) {
          continue;
        }

        const entry: OrchestrationEventFixture = {
          at: parsed.at,
          type: parsed.type,
          rootSessionID: parsed.rootSessionID,
          sessionID: parsed.sessionID,
          stage: parsed.stage,
        };

        if (parsed.details && typeof parsed.details === "object") {
          entry.details = parsed.details as Record<string, unknown>;
        }

        entries.push(entry);
      } catch {
        // Ignore malformed lines in test fixtures.
      }
    }

    return entries;
  } catch {
    return [];
  }
}

async function readExecutionGraph(
  root: string,
  rootSessionID: string,
  configuredPath = "_bmad-output/execution-graph.ndjson",
): Promise<ExecutionGraphEventFixture[]> {
  const filePath = configuredPath.startsWith("/") ? configuredPath : resolve(root, configuredPath);

  try {
    const raw = await readFile(filePath, "utf-8");
    const entries: ExecutionGraphEventFixture[] = [];
    for (const line of __orchestratorTestUtils.splitCommandQueueLines(raw)) {
      try {
        const parsed = JSON.parse(line) as Partial<ExecutionGraphEventFixture>;
        if (
          typeof parsed.seq !== "number" ||
          typeof parsed.ts !== "string" ||
          typeof parsed.rootSessionID !== "string" ||
          typeof parsed.eventType !== "string" ||
          typeof parsed.sessionID !== "string" ||
          typeof parsed.parentSessionID !== "string" ||
          (parsed.stage !== "triage" && parsed.stage !== "implementation" && parsed.stage !== "review") ||
          typeof parsed.taskRef !== "string" ||
          typeof parsed.agentID !== "string" ||
          typeof parsed.tier !== "string" ||
          typeof parsed.skillID !== "string" ||
          typeof parsed.parallelGroup !== "string" ||
          typeof parsed.slot !== "string" ||
          typeof parsed.status !== "string"
        ) {
          continue;
        }

        entries.push({
          seq: parsed.seq,
          ts: parsed.ts,
          rootSessionID: parsed.rootSessionID,
          eventType: parsed.eventType,
          sessionID: parsed.sessionID,
          parentSessionID: parsed.parentSessionID,
          stage: parsed.stage,
          taskRef: parsed.taskRef,
          agentID: parsed.agentID,
          tier: parsed.tier,
          skillID: parsed.skillID,
          parallelGroup: parsed.parallelGroup,
          slot: parsed.slot,
          status: parsed.status,
          reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        });
      } catch {
        // Ignore malformed lines in test fixtures.
      }
    }

    return entries.filter((entry) => entry.rootSessionID === rootSessionID).sort((left, right) => left.seq - right.seq);
  } catch {
    return [];
  }
}
