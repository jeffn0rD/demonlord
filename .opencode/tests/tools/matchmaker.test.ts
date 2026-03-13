import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { __matchmakerTestUtils, loadSkillDefinitions, resolveTaskRoute } from "../../tools/matchmaker.ts";

describe("matchmaker routing", () => {
  test("loads only valid SKILL.md files with strict naming validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "matchmaker-skills-"));

    try {
      await writeSkill(
        root,
        "frontend-specialist",
        "---\nname: frontend-specialist\ndescription: 'Build responsive interface flows'\n---\n# Frontend\n",
      );
      await writeSkill(
        root,
        "backend-specialist",
        "---\nname: backend-specialist\ndescription: Build API validation and service logic\n---\n# Backend\n",
      );
      await writeSkill(
        root,
        "invalid--name",
        "---\nname: invalid--name\ndescription: invalid naming\n---\n",
      );
      await writeSkill(
        root,
        "mismatch-specialist",
        "---\nname: backend-specialist\ndescription: mismatched directory\n---\n",
      );
      await writeSkill(root, "missing-description", "---\nname: missing-description\n---\n");

      const loaded = await loadSkillDefinitions(root);

      assert.deepEqual(
        loaded.map((skill) => skill.id),
        ["backend-specialist", "frontend-specialist"],
      );
      assert.match(loaded[0]?.description ?? "", /API validation/);
      assert.match(loaded[1]?.description ?? "", /responsive interface/);
      assert.equal(loaded[0]?.routingHints ?? "", "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("extracts routing hints section text from SKILL markdown", () => {
    const markdown = [
      "---",
      "name: config-guardian",
      "description: Guards config changes",
      "---",
      "",
      "## Core Responsibilities",
      "- keep config safe",
      "",
      "## Routing Hints",
      "- Keywords: config, schema, singular keys",
      "- Use for opencode.jsonc changes",
      "",
      "## Boundaries",
      "- keep diffs small",
    ].join("\n");

    const extracted = __matchmakerTestUtils.extractRoutingHints(markdown);
    assert.match(extracted, /Keywords: config, schema, singular keys/);
    assert.match(extracted, /Use for opencode\.jsonc changes/);
    assert.doesNotMatch(extracted, /keep diffs small/);
  });

  test("parses JSON router output from direct and embedded payloads", () => {
    const direct = __matchmakerTestUtils.parseRouterOutput(
      '{"skill_id":"frontend-specialist","reason":"UI ownership"}',
    );
    const embedded = __matchmakerTestUtils.parseRouterOutput(
      "router response:\n```json\n{\n  \"skill\": \"backend-specialist\"\n}\n```",
    );
    const invalid = __matchmakerTestUtils.parseRouterOutput("not-json");

    assert.deepEqual(direct, {
      skill_id: "frontend-specialist",
      reason: "UI ownership",
    });
    assert.equal(embedded?.skill_id, "backend-specialist");
    assert.equal(embedded?.reason, "LLM selected the closest skill.");
    assert.equal(invalid, null);
  });

  test("heuristic routing deterministically falls back when no overlap exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "matchmaker-fallback-"));

    try {
      await writeSkill(
        root,
        "backend-specialist",
        "---\nname: backend-specialist\ndescription: API schema validation and persistence\n---\n",
      );
      await writeSkill(
        root,
        "frontend-specialist",
        "---\nname: frontend-specialist\ndescription: accessibility interactions and css motion\n---\n",
      );

      const result = await resolveTaskRoute({
        taskDescription: "zyxwvu quxqaz",
        directory: root,
        worktree: root,
        mode: "heuristic",
      });

      assert.equal(result.mode, "heuristic");
      assert.equal(result.skill_id, "backend-specialist");
      assert.match(result.reason, /No overlap found; defaulted to backend-specialist/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("prefers spec-expert for ambiguous requests", () => {
    const result = __matchmakerTestUtils.routeHeuristically(
      "requirements are unclear and we need recommendations from docs",
      [
        {
          id: "backend-specialist",
          description: "Implements backend plugins",
          filePath: "/tmp/backend",
          body: "Handles orchestrator tool logic",
          routingHints: "Keywords: backend, api, plugin",
        },
        {
          id: "spec-expert",
          description: "Extracts requirements and constraints from documentation",
          filePath: "/tmp/spec",
          body: "Reads plan and tasklist files",
          routingHints: "Keywords: spec, requirement, acceptance, conflict",
        },
      ],
    );

    assert.equal(result.skill_id, "spec-expert");
    assert.match(result.reason, /Ambiguity-first policy selected spec-expert/);
  });

  test("weights routing hints higher than general body overlap", () => {
    const result = __matchmakerTestUtils.routeHeuristically(
      "update opencode jsonc singular keys and reasoningeffort variant",
      [
        {
          id: "backend-specialist",
          description: "Implements backend services",
          filePath: "/tmp/backend",
          body: "service logic opencode jsonc variant",
          routingHints: "Keywords: backend, api, service",
        },
        {
          id: "config-guardian",
          description: "Maintains OpenCode config safety",
          filePath: "/tmp/config",
          body: "policy and validation",
          routingHints: "Keywords: opencode jsonc schema singular keys reasoningeffort variant",
        },
      ],
    );

    assert.equal(result.skill_id, "config-guardian");
  });

  test("supports excluding skill IDs from routing", async () => {
    const root = await mkdtemp(join(tmpdir(), "matchmaker-exclude-"));

    try {
      await writeSkill(
        root,
        "spec-expert",
        [
          "---",
          "name: spec-expert",
          "description: Extracts requirements from docs",
          "---",
          "## Routing Hints",
          "- Keywords: spec, requirement, tasklist",
        ].join("\n"),
      );
      await writeSkill(
        root,
        "backend-specialist",
        [
          "---",
          "name: backend-specialist",
          "description: Implements backend logic",
          "---",
          "## Routing Hints",
          "- Keywords: backend, service, plugin",
        ].join("\n"),
      );

      const routed = await resolveTaskRoute({
        taskDescription: "requirements are unclear and need docs",
        directory: root,
        worktree: root,
        mode: "heuristic",
        excludeSkillIDs: ["spec-expert"],
      });

      assert.equal(routed.skill_id, "backend-specialist");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeSkill(root: string, directoryName: string, content: string): Promise<void> {
  const directory = resolve(root, ".opencode", "skills", directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "SKILL.md"), content, "utf-8");
}
