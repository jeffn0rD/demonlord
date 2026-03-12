import type { Plugin } from "@opencode-ai/plugin";
import type { Event, Session } from "@opencode-ai/sdk";

type PipelineStage = "triage" | "implementation" | "review";

const OrchestratorPlugin: Plugin = async ({ client, worktree }) => {
  const stageBySession = new Map<string, PipelineStage>();

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const session = event.properties.info;
        stageBySession.set(session.id, inferStageFromTitle(session.title));
        return;
      }

      if (event.type === "session.idle") {
        await handleSessionIdle(event);
        return;
      }

      if (event.type === "session.error") {
        await handleSessionError(event);
      }
    },
  };

  async function handleSessionIdle(event: Extract<Event, { type: "session.idle" }>): Promise<void> {
    const sessionID = event.properties.sessionID;
    const stage = await resolveStage(sessionID);

    if (stage === "triage") {
      await spawnFollowupSession({
        parentSessionID: sessionID,
        stage: "implementation",
        targetAgent: "minion",
        prompt: [
          "Triage session is complete.",
          "Execute the next implementation unit and report completion details.",
          "Use the matchmaker route_task tool to select the most suitable specialist skill before coding.",
        ].join("\n"),
      });
      return;
    }

    if (stage === "implementation") {
      await spawnFollowupSession({
        parentSessionID: sessionID,
        stage: "review",
        targetAgent: "reviewer",
        prompt: [
          "Implementation session is now idle.",
          "Review the completed changes, identify any risks, and prepare human-in-the-loop handoff notes.",
        ].join("\n"),
      });
      return;
    }

    await promptSession(
      sessionID,
      "Review stage is complete. Pipeline handoff is ready for final human approval.",
      "reviewer",
    );
  }

  async function handleSessionError(event: Extract<Event, { type: "session.error" }>): Promise<void> {
    const sessionID = event.properties.sessionID;
    if (!sessionID) {
      return;
    }

    const stage = await resolveStage(sessionID);
    const errorSummary = formatError(event.properties.error);

    await promptSession(
      sessionID,
      [
        `Pipeline stage '${stage}' reported an error: ${errorSummary}`,
        "Stabilize state, capture the blocker, and provide the next deterministic recovery step.",
      ].join("\n"),
      "orchestrator",
    );
  }

  async function spawnFollowupSession(input: {
    parentSessionID: string;
    stage: PipelineStage;
    targetAgent: string;
    prompt: string;
  }): Promise<void> {
    const parentSession = await getSession(input.parentSessionID);
    const titleStem = parentSession?.title ?? input.parentSessionID;
    const childTitle = `${input.stage}:${titleStem}`;

    const created = await client.session.create({
      body: {
        parentID: input.parentSessionID,
        title: childTitle,
      },
      query: {
        directory: worktree,
      },
    });

    const childSession = created.data;
    if (!childSession?.id) {
      return;
    }

    stageBySession.set(childSession.id, input.stage);
    await promptSession(childSession.id, input.prompt, input.targetAgent);
    await promptSession(
      input.parentSessionID,
      `Spawned ${input.stage} session ${childSession.id} (${input.targetAgent}).`,
      "orchestrator",
      true,
    );
  }

  async function resolveStage(sessionID: string): Promise<PipelineStage> {
    const cached = stageBySession.get(sessionID);
    if (cached) {
      return cached;
    }

    const session = await getSession(sessionID);
    const stage = inferStageFromTitle(session?.title ?? "");
    stageBySession.set(sessionID, stage);
    return stage;
  }

  async function getSession(sessionID: string): Promise<Session | null> {
    const response = await client.session.get({
      path: { id: sessionID },
      query: {
        directory: worktree,
      },
    });

    return response.data ?? null;
  }

  async function promptSession(
    sessionID: string,
    text: string,
    agent: string,
    noReply = false,
  ): Promise<void> {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        agent,
        noReply,
        parts: [{ type: "text", text }],
      },
      query: {
        directory: worktree,
      },
    });
  }
};

function inferStageFromTitle(title: string): PipelineStage {
  const normalized = title.toLowerCase();
  if (normalized.startsWith("triage:")) {
    return "triage";
  }

  if (normalized.startsWith("review:")) {
    return "review";
  }

  if (normalized.includes("triage")) {
    return "triage";
  }

  if (normalized.includes("review")) {
    return "review";
  }

  return "implementation";
}

function formatError(error: unknown): string {
  if (!error) {
    return "unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object") {
    const candidate = error as { message?: unknown; name?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : null;
    const name = typeof candidate.name === "string" ? candidate.name : null;

    if (message && name) {
      return `${name}: ${message}`;
    }

    if (message) {
      return message;
    }

    if (name) {
      return name;
    }
  }

  return "unknown error";
}

export default OrchestratorPlugin;
