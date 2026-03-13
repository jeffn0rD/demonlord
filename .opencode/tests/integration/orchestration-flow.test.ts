import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import OrchestratorPlugin, { __orchestratorTestUtils } from "../../plugins/orchestrator.ts";

type PipelineStage = "triage" | "implementation" | "review";
type TransitionState = "idle" | "awaiting_approval" | "in_progress" | "blocked" | "completed" | "stopped";

interface PipelineFixture {
  rootSessionID: string;
  currentStage: PipelineStage;
  transition: TransitionState;
  sessions: Record<string, unknown>;
  terminalNotified: boolean;
  stopped: boolean;
  stopReason?: "manual" | "global_off" | "completed";
  pendingTransition?: {
    from: PipelineStage;
    to: PipelineStage;
    requestedBySessionID: string;
    approvalRequired: boolean;
    approved: boolean;
    requestedAt: number;
  };
  error: {
    inProgress: boolean;
    attempts: number;
    handledSignatures: string[];
  };
  events: unknown[];
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

    __orchestratorTestUtils.applyGlobalOffToPipelines(pipelines);

    assert.equal(pipelines.manual.stopReason, "manual");
    assert.equal(pipelines.queued.stopReason, "global_off");
    assert.equal(pipelines.queued.transition, "stopped");
    assert.equal(pipelines.terminal.stopReason, "completed");

    const resumed = __orchestratorTestUtils.applyGlobalOnToPipelines(pipelines);

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
      const plugin = await OrchestratorPlugin({ client, worktree: root });

      await plugin.event?.({
        event: {
          type: "session.created",
          properties: {
            info: {
              id: "ses-root",
              parentID: undefined,
              directory: root,
              title: "triage: add integration coverage",
            },
          },
        },
      });

      await plugin.event?.({
        event: {
          type: "command.executed",
          properties: {
            name: "pipeline",
            sessionID: "ses-root",
            arguments: "advance implementation",
          },
        },
      });

      const snapshot = await readSnapshot(root);
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
      const plugin = await OrchestratorPlugin({ client, worktree: root });

      await plugin.event?.({
        event: {
          type: "session.created",
          properties: {
            info: {
              id: "ses-auto",
              parentID: undefined,
              directory: root,
              title: "triage: harden lifecycle",
            },
          },
        },
      });

      await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "ses-auto" } } });
      await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "ses-auto" } } });

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
      const plugin = await OrchestratorPlugin({ client, worktree: root });

      await plugin.event?.({
        event: {
          type: "session.created",
          properties: {
            info: {
              id: "ses-queue",
              parentID: undefined,
              directory: root,
              title: "triage: queue driven",
            },
          },
        },
      });

      const before = await readSnapshot(root);
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

      await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "ses-queue" } } });

      const after = await readSnapshot(root);
      const updatedPipeline = after.pipelines["ses-queue"];
      assert.equal(updatedPipeline.transition, "awaiting_approval");
      assert.equal(updatedPipeline.pendingTransition?.to, "implementation");
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
    }): Promise<{ data: { id: string; parentID?: string; directory: string; title: string } }>;
    get(input: { path: { id: string } }): Promise<{ data: { id: string; parentID?: string; directory: string; title: string } | null }>;
  };
}

function createMockClient(worktree: string): MockClient {
  const sessions = new Map<string, { id: string; parentID?: string; directory: string; title: string }>();
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
        const created = {
          id,
          parentID: input.body.parentID,
          directory: input.query.directory,
          title: input.body.title ?? id,
        };
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

async function writeConfig(
  root: string,
  orchestration: {
    enabled: boolean;
    mode: "off" | "manual" | "auto";
    require_approval_before_spawn: boolean;
    ignore_aborted_messages: boolean;
    verbose_events: boolean;
  },
): Promise<void> {
  await writeFile(resolve(root, "demonlord.config.json"), `${JSON.stringify({ orchestration }, null, 2)}\n`, "utf-8");
}

async function readSnapshot(root: string): Promise<{
  pipelines: Record<string, Record<string, unknown>>;
}> {
  const raw = await readFile(resolve(root, "_bmad-output", "orchestration-state.json"), "utf-8");
  const parsed = JSON.parse(raw) as {
    pipelines: Record<string, Record<string, unknown>>;
  };
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
