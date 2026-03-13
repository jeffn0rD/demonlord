import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { __orchestratorTestUtils } from "../../plugins/orchestrator.ts";

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
