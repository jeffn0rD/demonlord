export type SessionStage = "triage" | "implementation" | "review";

export interface SessionFixture {
  session_id: string;
  title: string;
  stage: SessionStage;
  active: boolean;
  persona: string;
  worktree: string;
}

export interface SessionFixtureOverrides {
  title?: string;
  stage?: SessionStage;
  active?: boolean;
  persona?: string;
  worktree?: string;
}

export interface SessionTargetResolution {
  ok: boolean;
  session_id?: string;
  reason?: string;
  candidates: string[];
}

export function createSessionFixture(sessionID: string, overrides: SessionFixtureOverrides = {}): SessionFixture {
  return {
    session_id: sessionID,
    title: overrides.title ?? `pipeline session ${sessionID}`,
    stage: overrides.stage ?? "implementation",
    active: overrides.active ?? true,
    persona: overrides.persona ?? "orchestrator",
    worktree: overrides.worktree ?? `/tmp/worktrees/${sessionID}`,
  };
}

export function createMultiSessionFixture(sessionIDs: readonly string[]): SessionFixture[] {
  return sessionIDs.map((sessionID, index) =>
    createSessionFixture(sessionID, {
      title: `pipeline-${index + 1}`,
      worktree: `/tmp/worktrees/pipeline-${index + 1}`,
    }),
  );
}

export function resolveSessionTarget(
  sessions: readonly SessionFixture[],
  explicitSessionID?: string,
): SessionTargetResolution {
  const activeSessions = sessions.filter((session) => session.active);
  const candidates = activeSessions.map((session) => session.session_id);

  if (explicitSessionID) {
    const exact = activeSessions.find((session) => session.session_id === explicitSessionID);
    if (!exact) {
      return {
        ok: false,
        reason: `No active session matches explicit session_id '${explicitSessionID}'.`,
        candidates,
      };
    }

    return {
      ok: true,
      session_id: exact.session_id,
      candidates,
    };
  }

  if (activeSessions.length === 1) {
    return {
      ok: true,
      session_id: activeSessions[0]?.session_id,
      candidates,
    };
  }

  if (activeSessions.length === 0) {
    return {
      ok: false,
      reason: "No active candidate session is available.",
      candidates,
    };
  }

  return {
    ok: false,
    reason: "Multiple active sessions found. Provide an explicit session_id.",
    candidates,
  };
}
