import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { __docsliceTestUtils, executeDocslice } from "../../tools/docslice.ts";

describe("docslice tool", () => {
  test("returns heading-bounded section for explicit file and heading", async () => {
    const root = await mkdtemp(join(tmpdir(), "docslice-explicit-"));

    try {
      await writeIndex(root);
      await writeGuideDoc(root);

      const result = await executeDocslice(
        {
          file_path: "doc/guide.md",
          heading: "Workflow State Machine",
          max_lines: 20,
          strict: true,
        },
        { worktree: root },
      );

      assert.equal(result.ok, true);
      assert.equal(result.file_path, "doc/guide.md");
      assert.equal(result.heading_used, "Workflow State Machine");
      assert.match(result.content ?? "", /^## Workflow State Machine/m);
      assert.doesNotMatch(result.content ?? "", /^## Another Section/m);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("infers file and heading from skill landmarks", async () => {
    const root = await mkdtemp(join(tmpdir(), "docslice-infer-"));

    try {
      await writeIndex(root);
      await writeGuideDoc(root);

      const result = await executeDocslice(
        {
          skill_id: "spec-expert",
          max_lines: 12,
        },
        { worktree: root },
      );

      assert.equal(result.ok, true);
      assert.equal(result.file_path, "doc/guide.md");
      assert.equal(result.heading_used, "Workflow State Machine");
      assert.match(result.content ?? "", /^## Workflow State Machine/m);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails in strict mode when heading does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "docslice-strict-"));

    try {
      await writeIndex(root);
      await writeGuideDoc(root);

      const result = await executeDocslice(
        {
          file_path: "doc/guide.md",
          heading: "Missing Heading",
          strict: true,
        },
        { worktree: root },
      );

      assert.equal(result.ok, false);
      assert.equal(result.code, "HEADING_NOT_FOUND");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is non-destructive for input files", async () => {
    const root = await mkdtemp(join(tmpdir(), "docslice-readonly-"));

    try {
      await writeIndex(root);
      await writeGuideDoc(root);

      const path = resolve(root, "doc", "guide.md");
      const before = await readFile(path, "utf-8");

      const result = await executeDocslice(
        {
          file_path: "doc/guide.md",
          heading: "Workflow State Machine",
          max_lines: 8,
        },
        { worktree: root },
      );

      const after = await readFile(path, "utf-8");
      assert.equal(result.ok, true);
      assert.equal(after, before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("parses index and locates landmarks deterministically", () => {
    const parsed = __docsliceTestUtils.parseAgentDocsIndex(sampleIndex());
    const skill = parsed.bySkillID.get("spec-expert");
    assert.ok(skill);
    assert.deepEqual(skill?.referencePaths, ["doc/guide.md"]);
    assert.equal(skill?.landmarks.length, 1);
  });
});

async function writeIndex(root: string): Promise<void> {
  const docRoot = resolve(root, "doc");
  await mkdir(docRoot, { recursive: true });
  await writeFile(resolve(docRoot, "agent_docs_index.md"), sampleIndex(), "utf-8");
}

async function writeGuideDoc(root: string): Promise<void> {
  const body = [
    "# Guide",
    "",
    "## Workflow State Machine",
    "Deterministic stage transitions.",
    "",
    "More details line 1.",
    "More details line 2.",
    "",
    "## Another Section",
    "Different context.",
  ].join("\n");
  await writeFile(resolve(root, "doc", "guide.md"), body, "utf-8");
}

function sampleIndex(): string {
  return [
    "# Agent Docs Index",
    "",
    "## Skill Map",
    "",
    "### `spec-expert`",
    "- Description: Interprets requirements",
    "- Skill file: `.opencode/skills/spec-expert/SKILL.md`",
    "- Reference paths: `doc/guide.md`",
    "- Landmarks:",
    "  - For pipeline flow: `doc/guide.md` (`Workflow State Machine`).",
    "- Context budget rules:",
    "  - Read only the needed heading.",
    "",
  ].join("\n");
}
