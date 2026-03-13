import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { runPipelineCtl } from "../../../agents/tools/pipelinectl.ts";

interface CaptureIO {
  stdout: string[];
  stderr: string[];
  io: {
    stdout(message: string): void;
    stderr(message: string): void;
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const next = temporaryDirectories.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe("pipelinectl", () => {
  test("rejects invalid advance transitions with actionable error", async () => {
    const fixture = await createFixture({
      pipelines: {
        "ses-root": {
          rootSessionID: "ses-root",
          currentStage: "triage",
          transition: "idle",
          stopped: false,
          updatedAt: 100,
        },
      },
      sessionToRoot: {
        "ses-root": "ses-root",
      },
    });
    const capture = createCaptureIO();

    const exitCode = await runPipelineCtl(["advance", "review", "ses-root"], fixture.env, capture.io);

    assert.equal(exitCode, 1);
    assert.match(capture.stderr.join(""), /Invalid transition triage -> review/);
    const queued = await readQueueFile(fixture.queuePath);
    assert.equal(queued.length, 0);
  });

  test("deduplicates repeated commands using queue dedupe keys", async () => {
    const fixture = await createFixture({
      pipelines: {
        "ses-root": {
          rootSessionID: "ses-root",
          currentStage: "implementation",
          transition: "idle",
          stopped: false,
          updatedAt: 200,
        },
      },
      sessionToRoot: {
        "ses-root": "ses-root",
      },
    });
    const first = createCaptureIO();
    const second = createCaptureIO();

    const firstExit = await runPipelineCtl(["stop", "ses-root"], fixture.env, first.io);
    const secondExit = await runPipelineCtl(["stop", "ses-root"], fixture.env, second.io);

    assert.equal(firstExit, 0);
    assert.equal(secondExit, 1);
    assert.match(second.stderr.join(""), /Duplicate command ignored/);
    const queued = await readQueueFile(fixture.queuePath);
    assert.equal(queued.length, 1);
  });

  test("prints deterministic status output for selected pipeline", async () => {
    const fixture = await createFixture({
      pipelines: {
        "ses-root": {
          rootSessionID: "ses-root",
          currentStage: "review",
          transition: "completed",
          stopped: true,
          stopReason: "completed",
          updatedAt: 300,
        },
      },
      sessionToRoot: {
        "ses-root": "ses-root",
      },
    });
    const capture = createCaptureIO();

    const exitCode = await runPipelineCtl(["status"], fixture.env, capture.io);

    assert.equal(exitCode, 0);
    const output = capture.stdout.join("");
    assert.match(output, /Pipeline: ses-root/);
    assert.match(output, /Mode: manual/);
    assert.match(output, /Stage: review/);
  });
});

function createCaptureIO(): CaptureIO {
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

async function createFixture(input: {
  pipelines: Record<string, Record<string, unknown>>;
  sessionToRoot: Record<string, string>;
}): Promise<{ env: NodeJS.ProcessEnv; queuePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "pipelinectl-test-"));
  temporaryDirectories.push(root);

  const outputDir = resolve(root, "_bmad-output");
  await mkdir(outputDir, { recursive: true });

  const statePath = resolve(outputDir, "orchestration-state.json");
  const queuePath = resolve(outputDir, "orchestration-commands.ndjson");
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        version: 2,
        updatedAt: new Date(0).toISOString(),
        runtime: {
          off: false,
          enabled: true,
          configuredMode: "manual",
          effectiveMode: "manual",
        },
        sessionToRoot: input.sessionToRoot,
        pipelines: input.pipelines,
        pipelineSummaries: input.pipelines,
        commandQueue: {
          path: queuePath,
          lastProcessedLine: 0,
          processedDedupes: {},
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  return {
    env: {
      OPENCODE_WORKTREE: root,
      OPENCODE_ORCHESTRATION_STATE: statePath,
      OPENCODE_ORCHESTRATION_COMMAND_QUEUE: queuePath,
      OPENCODE_SESSION_ID: "ses-root",
    },
    queuePath,
  };
}

async function readQueueFile(queuePath: string): Promise<string[]> {
  try {
    const raw = await readFile(queuePath, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}
