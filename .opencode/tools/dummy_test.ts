import { createOpencodeClient } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin/tool";

const DEFAULT_SERVER_URL = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096";
const CHILD_COMMAND = "dummy-prompt";
const ANSWER_MARKER_PATTERN = /<--\s*ANSWER\s+"([\s\S]*?)"\s*-->/i;
const MESSAGE_POLL_ATTEMPTS = 5;

interface DummyTestArgs {}

interface DummyTestContext {
  directory: string;
  worktree: string;
}

type OutputSource = "command_parts" | "session_messages" | "none";

interface DummyRuntimeCommandInput {
  title: string;
  command: string;
  arguments: string;
  agent: "reviewer";
  model?: string;
}

interface DummyRuntimeCommandResult {
  sessionID: string;
  outputText: string;
  source: OutputSource;
  pollCount: number;
}

interface DummyRuntime {
  runCommand(input: DummyRuntimeCommandInput): Promise<DummyRuntimeCommandResult>;
}

interface ParsedAnswerMarker {
  markerFound: boolean;
  answer?: string;
  error?: string;
}

interface DummyTestResult {
  ok: boolean;
  command: string;
  child_command: string;
  marker_found: boolean;
  answer: string | null;
  source: OutputSource;
  poll_count: number;
  output_excerpt: string;
  session_id?: string;
  marker_error?: string;
  error?: string;
}

export const dummyTestTool = tool({
  description: "Minimal test for parent-child session marker visibility",
  args: {},
  async execute(args: DummyTestArgs, context: DummyTestContext) {
    const result = await executeDummyTest(args, context);
    return JSON.stringify(result, null, 2);
  },
});

export async function executeDummyTest(
  _args: DummyTestArgs,
  context: DummyTestContext,
  runtime: DummyRuntime = createSdkRuntime(context),
): Promise<DummyTestResult> {
  let runResult: DummyRuntimeCommandResult;

  try {
    runResult = await runtime.runCommand({
      title: "dummy-test-marker-visibility",
      command: CHILD_COMMAND,
      arguments: "",
      agent: "reviewer",
    });
  } catch (error) {
    return {
      ok: false,
      command: "dummy-test",
      child_command: CHILD_COMMAND,
      marker_found: false,
      answer: null,
      source: "none",
      poll_count: 0,
      output_excerpt: "",
      error: formatUnknownError(error),
    };
  }

  const parsedMarker = parseAnswerMarker(runResult.outputText);

  return {
    ok: parsedMarker.markerFound,
    command: "dummy-test",
    child_command: CHILD_COMMAND,
    marker_found: parsedMarker.markerFound,
    answer: parsedMarker.answer ?? null,
    source: runResult.source,
    poll_count: runResult.pollCount,
    output_excerpt: runResult.outputText.slice(0, 1200),
    session_id: runResult.sessionID,
    marker_error: parsedMarker.error,
    error: parsedMarker.markerFound ? undefined : parsedMarker.error,
  };
}

function createSdkRuntime(context: DummyTestContext): DummyRuntime {
  const client = createOpencodeClient({
    baseUrl: DEFAULT_SERVER_URL,
    directory: context.directory,
  });
  const sessionApi = client.session as {
    messages?: (input: {
      path: { id: string };
      query: { directory: string };
    }) => Promise<{ data: unknown }>;
    delete?: (input: {
      path: { id: string };
      query: { directory: string };
    }) => Promise<unknown>;
  };

  return {
    async runCommand(input: DummyRuntimeCommandInput): Promise<DummyRuntimeCommandResult> {
      let sessionID: string | null = null;

      try {
        const created = await client.session.create({
          body: {
            title: input.title,
          },
          query: {
            directory: context.worktree,
          },
        });

        const createdSession = created.data as { id?: unknown } | undefined;
        if (!createdSession || typeof createdSession.id !== "string" || createdSession.id.trim().length === 0) {
          throw new Error("Failed to create dummy test session.");
        }
        sessionID = createdSession.id;

        const commandResponse = await client.session.command({
          path: { id: sessionID },
          body: {
            command: input.command,
            arguments: input.arguments,
            agent: input.agent,
            model: input.model,
          },
          query: {
            directory: context.worktree,
          },
        });

        const commandOutput = collectTextParts(commandResponse.data);
        if (parseAnswerMarker(commandOutput).markerFound) {
          return {
            sessionID,
            outputText: commandOutput,
            source: "command_parts",
            pollCount: 0,
          };
        }

        if (typeof sessionApi.messages !== "function") {
          return {
            sessionID,
            outputText: commandOutput,
            source: commandOutput.length > 0 ? "command_parts" : "none",
            pollCount: 0,
          };
        }

        let latestMessageOutput = "";
        for (let attempt = 1; attempt <= MESSAGE_POLL_ATTEMPTS; attempt += 1) {
          const messageResponse = await sessionApi.messages({
            path: { id: sessionID },
            query: {
              directory: context.worktree,
            },
          });

          const candidateOutput = collectLatestMessageText(messageResponse.data);
          if (candidateOutput.length > 0) {
            latestMessageOutput = candidateOutput;
            const mergedOutput = [commandOutput, latestMessageOutput].filter((value) => value.length > 0).join("\n").trim();
            if (parseAnswerMarker(mergedOutput).markerFound) {
              return {
                sessionID,
                outputText: mergedOutput,
                source: "session_messages",
                pollCount: attempt,
              };
            }
          }

          if (attempt < MESSAGE_POLL_ATTEMPTS) {
            await delay(attempt * 100);
          }
        }

        if (latestMessageOutput.length > 0) {
          return {
            sessionID,
            outputText: [commandOutput, latestMessageOutput].filter((value) => value.length > 0).join("\n").trim(),
            source: "session_messages",
            pollCount: MESSAGE_POLL_ATTEMPTS,
          };
        }

        return {
          sessionID,
          outputText: commandOutput,
          source: commandOutput.length > 0 ? "command_parts" : "none",
          pollCount: MESSAGE_POLL_ATTEMPTS,
        };
      } finally {
        if (sessionID && typeof sessionApi.delete === "function") {
          await sessionApi
            .delete({
              path: { id: sessionID },
              query: {
                directory: context.worktree,
              },
            })
            .catch(() => undefined);
        }
      }
    },
  };
}

function collectTextParts(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const candidate = payload as { parts?: unknown };
  if (!Array.isArray(candidate.parts)) {
    return "";
  }

  const textParts: string[] = [];
  for (const part of candidate.parts) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      textParts.push(typed.text);
    }
  }

  return textParts.join("\n").trim();
}

function collectLatestMessageText(payload: unknown): string {
  if (!Array.isArray(payload)) {
    return "";
  }

  for (let index = payload.length - 1; index >= 0; index -= 1) {
    const text = collectTextParts(payload[index]);
    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

function parseAnswerMarker(rawOutput: string): ParsedAnswerMarker {
  const match = rawOutput.match(ANSWER_MARKER_PATTERN);
  if (!match || typeof match[1] !== "string") {
    return {
      markerFound: false,
      error: "ANSWER marker not found.",
    };
  }

  return {
    markerFound: true,
    answer: match[1],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "unknown error";
}

export const __dummyTestTool = {
  parseAnswerMarker,
};

export default dummyTestTool;
