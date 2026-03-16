#!/usr/bin/env node

import { readFile, readdir, stat, writeFile } from "fs/promises";
import { dirname, posix, relative, resolve } from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const OPENCODE_SOURCE_ROOT = resolve(SCRIPT_DIR, "..");
const SKILLS_ROOT = resolve(OPENCODE_SOURCE_ROOT, "skills");
const INDEX_PATH = resolve(WORKTREE_ROOT, "doc", "agent_docs_index.md");

const REQUIRED_SECTIONS = ["Routing Hints", "Context Budget Rules"];
const LANDMARK_SECTION_NAMES = ["Targeted Navigation Hints", "Targeted Spec Navigation Hints"];
const MAX_REFERENCE_PATHS_PER_SKILL = 14;
const REFERENCE_SECTION_NAMES = [
  "Primary Files",
  "Mandatory Reference Files",
  "Mandatory Sources",
  "Targeted Navigation Hints",
  "Targeted Spec Navigation Hints",
];
const SKILL_ID_SCAN_FILES = [
  "doc/routing_policy.md",
  "doc/engineering_spec.md",
  "doc/Autonomous_Factory_Summary.md",
  "doc/tests_backlog.md",
  "payload/dot-opencode/tests/harness/discord-contracts.v1.json",
];
const IGNORED_WALK_DIRECTORIES = new Set([".git", "node_modules"]);

const args = new Set(process.argv.slice(2));
const wantsHelp = args.has("--help") || args.has("-h");
const writeMode = args.has("--write");
const checkMode = args.has("--check") || !writeMode;

if (wantsHelp) {
  printHelp();
  process.exit(0);
}

const result = await runMaintenance({ writeMode, checkMode });
if (!result.ok) {
  process.exit(1);
}

async function runMaintenance({ writeMode, checkMode }) {
  const errors = [];
  const allRelativePaths = await collectRelativePaths(WORKTREE_ROOT);
  const skillDirectories = await listSkillDirectories(SKILLS_ROOT);
  const skills = [];

  for (const directoryName of skillDirectories) {
    const skillPath = resolve(SKILLS_ROOT, directoryName, "SKILL.md");
    let body = "";
    try {
      body = await readFile(skillPath, "utf-8");
    } catch (error) {
      if (isFileMissingError(error)) {
        continue;
      }
      errors.push(`Failed to read ${relativeForDisplay(skillPath)}: ${formatError(error)}`);
      continue;
    }

    const frontmatter = parseFrontmatter(body);
    if (!frontmatter) {
      errors.push(`${relativeForDisplay(skillPath)} is missing required frontmatter name/description.`);
      continue;
    }

    if (frontmatter.name !== directoryName) {
      errors.push(
        `${relativeForDisplay(skillPath)} name mismatch: frontmatter name '${frontmatter.name}' must equal directory '${directoryName}'.`,
      );
      continue;
    }

    const sections = parseSections(body);
    for (const sectionName of REQUIRED_SECTIONS) {
      const bulletLines = extractBulletLines(sections, sectionName);
      if (bulletLines.length === 0) {
        errors.push(`${relativeForDisplay(skillPath)} is missing non-empty '${sectionName}' section.`);
      }
    }

    const referencePaths = extractReferencePaths(sections, REFERENCE_SECTION_NAMES);
    if (referencePaths.length === 0) {
      errors.push(
        `${relativeForDisplay(skillPath)} has no reference paths in Primary/Mandatory/Targeted Navigation sections.`,
      );
    }
    if (referencePaths.length > MAX_REFERENCE_PATHS_PER_SKILL) {
      errors.push(
        `${relativeForDisplay(skillPath)} has ${referencePaths.length} reference paths (max ${MAX_REFERENCE_PATHS_PER_SKILL}). Reduce broad references to keep context budgets tight.`,
      );
    }

    const landmarks = extractBulletLinesFromMany(sections, LANDMARK_SECTION_NAMES);
    if (landmarks.length === 0) {
      errors.push(
        `${relativeForDisplay(skillPath)} must include at least one landmark in Targeted Navigation/Spec Navigation hints.`,
      );
    }

    for (const referencePath of referencePaths) {
      if (!isResolvableReference(referencePath)) {
        continue;
      }
      if (!referenceExists(referencePath, allRelativePaths)) {
        errors.push(
          `${relativeForDisplay(skillPath)} references missing path/pattern '${referencePath}'.`,
        );
      }
    }

    skills.push({
      id: frontmatter.name,
      description: frontmatter.description,
      filePath: relativeForDisplay(skillPath),
      referencePaths,
      landmarks,
      contextBudgetRules: extractBulletLines(sections, "Context Budget Rules"),
      routingKeywords: extractRoutingKeywords(extractBulletLines(sections, "Routing Hints")),
    });
  }

  skills.sort((left, right) => left.id.localeCompare(right.id));
  errors.push(...(await validateSkillIDsInDocs(new Set(skills.map((skill) => skill.id)))));

  const renderedIndex = renderIndex(skills);
  const existingIndex = await safeRead(INDEX_PATH);
  const indexChanged = existingIndex !== renderedIndex;

  if (writeMode && indexChanged) {
    await writeFile(INDEX_PATH, renderedIndex, "utf-8");
  }

  if (checkMode && indexChanged) {
    errors.push(`${relativeForDisplay(INDEX_PATH)} is out of date. Run: npm run skills:maintain (from .opencode).`);
  }

  if (errors.length > 0) {
    console.error("Skill docs maintenance failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    return {
      ok: false,
      errors,
    };
  }

  const modeLabel = writeMode ? "write" : "check";
  console.log(`Skill docs maintenance passed (${modeLabel} mode).`);
  console.log(`- Skills indexed: ${skills.length}`);
  console.log(`- Index path: ${relativeForDisplay(INDEX_PATH)}`);
  if (writeMode) {
    console.log(`- Index updated: ${indexChanged ? "yes" : "no"}`);
  }

  return {
    ok: true,
  };
}

function printHelp() {
  console.log("Usage: node payload/dot-opencode/scripts/skill_docs_maintenance.mjs [--check|--write]");
  console.log("  --check  Validate skill references and index freshness (default)");
  console.log("  --write  Regenerate doc/agent_docs_index.md and validate references");
}

async function listSkillDirectories(skillsRoot) {
  let entries = [];
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }

  const payload = match[1] ?? "";
  const nameMatch = payload.match(/^name:\s*(.+)$/m);
  const descriptionMatch = payload.match(/^description:\s*(.+)$/m);
  if (!nameMatch || !descriptionMatch) {
    return null;
  }

  const name = stripQuoted(nameMatch[1] ?? "").trim();
  const description = stripQuoted(descriptionMatch[1] ?? "").trim();
  if (!name || !description) {
    return null;
  }

  return { name, description };
}

function stripQuoted(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSections(markdown) {
  const sections = new Map();
  let current = "";
  sections.set(current, []);

  for (const line of markdown.split("\n")) {
    const headingMatch = line.trim().match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      current = normalizeHeading(headingMatch[1] ?? "");
      if (!sections.has(current)) {
        sections.set(current, []);
      }
      continue;
    }

    if (!sections.has(current)) {
      sections.set(current, []);
    }
    sections.get(current).push(line);
  }

  return sections;
}

function normalizeHeading(value) {
  return value.trim().toLowerCase();
}

function extractBulletLines(sections, sectionName) {
  const lines = sections.get(normalizeHeading(sectionName)) ?? [];
  const bullets = [];
  for (const line of lines) {
    const match = line.match(/^-\s+(.+?)\s*$/);
    if (match) {
      bullets.push(match[1]);
    }
  }
  return bullets;
}

function extractBulletLinesFromMany(sections, sectionNames) {
  const values = [];
  for (const sectionName of sectionNames) {
    values.push(...extractBulletLines(sections, sectionName));
  }
  return values;
}

function extractReferencePaths(sections, sectionNames) {
  const values = new Set();

  for (const sectionName of sectionNames) {
    const bulletLines = extractBulletLines(sections, sectionName);
    for (const bulletLine of bulletLines) {
      const tokens = extractBacktickTokens(bulletLine);
      if (tokens.length === 0) {
        const normalized = normalizeReferenceToken(bulletLine);
        if (looksLikePlainPath(normalized)) {
          values.add(normalized);
        }
        continue;
      }

      for (const token of tokens) {
        const normalized = normalizeReferenceToken(token);
        if (looksLikePath(normalized)) {
          values.add(normalized);
        }
      }
    }
  }

  return Array.from(values).sort((left, right) => left.localeCompare(right));
}

function extractBacktickTokens(value) {
  const tokens = [];
  const matcher = /`([^`]+)`/g;
  for (const match of value.matchAll(matcher)) {
    const token = (match[1] ?? "").trim();
    if (token) {
      tokens.push(token);
    }
  }
  return tokens;
}

function normalizeReferenceToken(value) {
  return value
    .trim()
    .replace(/^<worktree>\//, "")
    .replace(/[),.:;]+$/, "")
    .replace(/\\/g, "/");
}

function looksLikePath(value) {
  if (!value) {
    return false;
  }
  if (value.startsWith("/")) {
    return true;
  }
  if (value.includes("/") || value.includes("*")) {
    return true;
  }
  return /\.(md|jsonc?|ndjson|ts|js|sh)$/i.test(value);
}

function looksLikePlainPath(value) {
  if (!value || /\s/.test(value)) {
    return false;
  }
  return looksLikePath(value);
}

function isResolvableReference(referencePath) {
  return !referencePath.includes("<") && !referencePath.includes(">") && !referencePath.includes("{") && !referencePath.includes("}");
}

function referenceExists(referencePath, allRelativePaths) {
  const aliases = expandReferenceAliases(referencePath.replace(/^\.\//, ""));
  for (const alias of aliases) {
    if (alias.includes("*")) {
      const matcher = globToRegExp(alias);
      if (allRelativePaths.some((entry) => matcher.test(entry))) {
        return true;
      }
      continue;
    }

    const normalizedDirectory = alias.endsWith("/") ? alias : `${alias}/`;
    if (allRelativePaths.includes(alias) || allRelativePaths.includes(normalizedDirectory)) {
      return true;
    }
  }

  return false;
}

function expandReferenceAliases(referencePath) {
  const aliases = new Set([referencePath]);
  if (referencePath === ".opencode" || referencePath.startsWith(".opencode/")) {
    const suffix = referencePath.slice(".opencode".length);
    aliases.add(`payload/dot-opencode${suffix}`);
  }
  return Array.from(aliases);
}

function globToRegExp(globPattern) {
  let expression = "^";
  for (let index = 0; index < globPattern.length; index += 1) {
    const character = globPattern[index];
    const nextCharacter = globPattern[index + 1];

    if (character === "*" && nextCharacter === "*") {
      expression += ".*";
      index += 1;
      continue;
    }

    if (character === "*") {
      expression += "[^/]*";
      continue;
    }

    if (character === "?") {
      expression += "[^/]";
      continue;
    }

    expression += escapeRegExp(character);
  }
  expression += "$";
  return new RegExp(expression);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

async function collectRelativePaths(rootPath) {
  const entries = [];
  await walkDirectory(rootPath, rootPath, entries);
  return entries.sort((left, right) => left.localeCompare(right));
}

async function walkDirectory(rootPath, currentPath, entries) {
  const directoryEntries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of directoryEntries) {
    if (IGNORED_WALK_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const absolute = resolve(currentPath, entry.name);
    const rel = posix.normalize(relative(rootPath, absolute).split("\\").join("/"));
    if (!rel || rel === ".") {
      continue;
    }

    if (entry.isDirectory()) {
      entries.push(`${rel}/`);
      await walkDirectory(rootPath, absolute, entries);
      continue;
    }

    entries.push(rel);
  }
}

async function validateSkillIDsInDocs(knownSkillIDs) {
  const errors = [];
  for (const relativePath of SKILL_ID_SCAN_FILES) {
    const absolutePath = resolve(WORKTREE_ROOT, relativePath);
    let content = "";
    try {
      const fileStats = await stat(absolutePath);
      if (!fileStats.isFile()) {
        continue;
      }
      content = await readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    const unknownSkillIDs = findUnknownSkillIDs(content, knownSkillIDs);
    for (const skillID of unknownSkillIDs) {
      errors.push(`${relativePath} references unknown skill ID '${skillID}'.`);
    }
  }
  return errors;
}

function findUnknownSkillIDs(content, knownSkillIDs) {
  const unknown = new Set();
  const matcher = /\b([a-z0-9]+(?:-[a-z0-9]+)*-specialist)\b/g;
  for (const match of content.matchAll(matcher)) {
    const skillID = match[1] ?? "";
    if (!knownSkillIDs.has(skillID)) {
      unknown.add(skillID);
    }
  }
  return Array.from(unknown).sort((left, right) => left.localeCompare(right));
}

function extractRoutingKeywords(routingBullets) {
  for (const line of routingBullets) {
    if (/^keywords:/i.test(line)) {
      return line.replace(/^keywords:\s*/i, "").trim();
    }
  }
  return "";
}

function renderIndex(skills) {
  const lines = [
    "# Agent Docs Index",
    "",
    "This file is generated by `payload/dot-opencode/scripts/skill_docs_maintenance.mjs`.",
    "Do not edit manually. Run `npm run skills:maintain` from `payload/dot-opencode`.",
    "",
    "## Purpose",
    "",
    "- Provide low-context document landmarks per skill.",
    "- Keep skill reference paths and skill IDs valid across core docs.",
    "",
    "## Skill Map",
    "",
  ];

  for (const skill of skills) {
    lines.push(`### \`${skill.id}\``);
    lines.push(`- Description: ${skill.description}`);
    lines.push(`- Skill file: \`${skill.filePath}\``);
    lines.push(`- Reference paths: ${formatInlineReferenceList(skill.referencePaths)}`);

    if (skill.routingKeywords) {
      lines.push(`- Routing keywords: ${skill.routingKeywords}`);
    }

    if (skill.landmarks.length > 0) {
      lines.push("- Landmarks:");
      for (const landmark of skill.landmarks) {
        lines.push(`  - ${landmark}`);
      }
    } else {
      lines.push("- Landmarks: (none)");
    }

    lines.push("- Context budget rules:");
    for (const rule of skill.contextBudgetRules) {
      lines.push(`  - ${rule}`);
    }

    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatInlineReferenceList(referencePaths) {
  if (referencePaths.length === 0) {
    return "(none)";
  }
  return referencePaths.map((value) => `\`${value}\``).join(", ");
}

async function safeRead(filePath) {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

function relativeForDisplay(filePath) {
  return posix.normalize(relative(WORKTREE_ROOT, filePath).split("\\").join("/"));
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isFileMissingError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
