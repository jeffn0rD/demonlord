import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { __dummyTestTool, executeDummyTest } from "../../tools/dummy_test.ts";

interface RuntimeInvocation {
  title: string;
  command: string;
  arguments: string;
  agent: "reviewer";
  model?: string;
}

describe("dummy_test tool", () => {
  test("parses answer marker payload", () => {
    const parsed = __dummyTestTool.parseAnswerMarker('<-- ANSWER "calm" -->');
    assert.equal(parsed.markerFound, true);
    assert.equal(parsed.answer, "calm");
  });

  test("reports success when marker is captured from command output parts", async () => {
    const runtime = createMockRuntime([
      {
        outputText: '<-- ANSWER "focused" -->',
        source: "command_parts",
        pollCount: 0,
      },
    ]);

    const result = await executeDummyTest({}, { directory: "/tmp", worktree: "/tmp" }, runtime);
    assert.equal(result.ok, true);
    assert.equal(result.marker_found, true);
    assert.equal(result.answer, "focused");
    assert.equal(result.source, "command_parts");
    assert.equal(runtime.invocations.length, 1);
    assert.equal(runtime.invocations[0]?.command, "dummy-prompt");
  });

  test("reports success when marker is captured from session messages fallback", async () => {
    const runtime = createMockRuntime([
      {
        outputText: 'response: <-- ANSWER "steady" -->',
        source: "session_messages",
        pollCount: 2,
      },
    ]);

    const result = await executeDummyTest({}, { directory: "/tmp", worktree: "/tmp" }, runtime);
    assert.equal(result.ok, true);
    assert.equal(result.answer, "steady");
    assert.equal(result.source, "session_messages");
    assert.equal(result.poll_count, 2);
  });

  test("fails cleanly when marker is not present", async () => {
    const runtime = createMockRuntime([
      {
        outputText: "no marker in this output",
        source: "command_parts",
        pollCount: 0,
      },
    ]);

    const result = await executeDummyTest({}, { directory: "/tmp", worktree: "/tmp" }, runtime);
    assert.equal(result.ok, false);
    assert.equal(result.marker_found, false);
    assert.equal(result.answer, null);
    assert.match(result.error ?? "", /ANSWER marker not found/i);
  });
});

function createMockRuntime(outputs: Array<{ outputText: string; source: "command_parts" | "session_messages" | "none"; pollCount: number }>): {
  runCommand: (input: RuntimeInvocation) => Promise<{ sessionID: string; outputText: string; source: "command_parts" | "session_messages" | "none"; pollCount: number }>;
  invocations: RuntimeInvocation[];
} {
  const invocations: RuntimeInvocation[] = [];
  let index = 0;

  return {
    invocations,
    async runCommand(input: RuntimeInvocation): Promise<{ sessionID: string; outputText: string; source: "command_parts" | "session_messages" | "none"; pollCount: number }> {
      invocations.push(input);
      const output = outputs[index] ?? { outputText: "", source: "none" as const, pollCount: 0 };
      index += 1;

      return {
        sessionID: `session-${index}`,
        outputText: output.outputText,
        source: output.source,
        pollCount: output.pollCount,
      };
    },
  };
}
