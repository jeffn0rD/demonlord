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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
});

async function writeSkill(root: string, directoryName: string, content: string): Promise<void> {
  const directory = resolve(root, ".opencode", "skills", directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "SKILL.md"), content, "utf-8");
}
