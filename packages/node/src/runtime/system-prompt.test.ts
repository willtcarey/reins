import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildReinsSystemPrompt } from "./system-prompt.js";

describe("buildReinsSystemPrompt", () => {
  test("includes REINS identity and tool list", () => {
    const prompt = buildReinsSystemPrompt({
      tools: [
        { name: "read" },
        { name: "bash" },
        { name: "create_task", description: "Create a task" },
      ],
      includePiDocs: false,
    });

    expect(prompt).toContain("You are REINS, an agentic harness");
    expect(prompt).toContain("Available tools:");
    expect(prompt).toContain("- read: Read file contents");
    expect(prompt).toContain("- create_task: Create a task");
    expect(prompt).not.toContain("REINS documentation");
  });

  test("can include REINS docs section", () => {
    const prompt = buildReinsSystemPrompt({
      tools: [{ name: "read" }],
      includePiDocs: true,
    });

    expect(prompt).toContain("REINS documentation (read only when the user asks about REINS itself)");
    expect(prompt).toContain("docs/dev");
    expect(prompt).toContain("docs/features");
    expect(prompt).toContain("docs/features/skills.md");
    expect(prompt).not.toContain("@earendil-works/pi-coding-agent");
    expect(prompt).not.toContain("extensions");
    expect(prompt).not.toContain("themes");
    expect(prompt).not.toContain("TUI");
  });

  test("appends context files when provided", () => {
    const prompt = buildReinsSystemPrompt({
      tools: [{ name: "read" }],
      includePiDocs: false,
      contextFiles: [
        { path: "/project/AGENTS.md", content: "Follow these rules." },
      ],
    });

    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("## /project/AGENTS.md");
    expect(prompt).toContain("Follow these rules.");
  });

  test("appends skills when provided", () => {
    const prompt = buildReinsSystemPrompt({
      tools: [{ name: "read" }],
      includePiDocs: false,
      skills: [{
        name: "test-skill",
        description: "A test skill.",
        filePath: "/skills/test-skill/SKILL.md",
        baseDir: "/skills/test-skill",
        source: "project",
        disableModelInvocation: false,
      }],
    });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>test-skill</name>");
    expect(prompt).toContain("<description>A test skill.</description>");
    expect(prompt).toContain("</available_skills>");
  });

  test("includes task context when task is provided", () => {
    const prompt = buildReinsSystemPrompt({
      tools: [{ name: "read" }],
      includePiDocs: false,
      task: { title: "Fix login bug", description: "Users can't log in" },
    });

    expect(prompt).toContain("## Task");
    expect(prompt).toContain("Fix login bug");
    expect(prompt).toContain("Users can't log in");
    expect(prompt).toContain("You are working on this task");
    expect(prompt).not.toContain("project assistant session");
  });

  test("includes scratch session guidance when isScratchSession is true", () => {
    const prompt = buildReinsSystemPrompt({
      tools: [{ name: "read" }],
      includePiDocs: false,
      isScratchSession: true,
    });

    expect(prompt).toContain("project assistant session");
    expect(prompt).toContain("Prefer a dedicated task session/branch for implementation work");
    expect(prompt).toContain("When the user explicitly asks to implement in this session, do the work here");
    expect(prompt).toContain("Only create a task when the user explicitly asks");
    expect(prompt).not.toContain("Do not implement features or make substantial code changes");
    expect(prompt).toContain("You may check out branches, including task/* branches");
    expect(prompt).toContain("Small direct changes such as doc updates, config tweaks, and quick fixes are allowed");
    expect(prompt).not.toContain("## Task");
  });

  test("does not append skills or context files when not provided", () => {
    const prompt = buildReinsSystemPrompt({
      tools: [{ name: "read" }],
      includePiDocs: false,
    });

    expect(prompt).not.toContain("# Project Context");
    expect(prompt).not.toContain("<available_skills>");
  });
});

// Fixtures were rendered by the server's copy of this function before it moved to the node; the
// node and legacy server paths must keep producing these bytes. `<REINS_ROOT>` is the repo root.
describe("buildReinsSystemPrompt output is byte-identical to the pre-move server rendering", () => {
  const root = fileURLToPath(new URL("../../../..", import.meta.url)).replace(/\/$/, "");
  const expected = (name: string) => readFileSync(new URL(`./__fixtures__/system-prompt/${name}.txt`, import.meta.url), "utf8").replaceAll("<REINS_ROOT>", root);
  const tools = [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" },
    { name: "execute", description: "Run a Reins script." }, { name: "search", description: "  Search the API.\n" }, { name: "create_task", description: "" }];
  const contextFiles = [{ path: "/project/AGENTS.md", content: "Follow these rules." }, { path: "/home/u/.reins/AGENTS.md", content: "Global rules.\nLine 2." }];
  const skills = [
    { name: "test-skill", description: "A test skill.", filePath: "/skills/test-skill/SKILL.md", baseDir: "/skills/test-skill", source: "project", disableModelInvocation: false },
    { name: "hidden", description: "Hidden <&>.", filePath: "/skills/hidden/SKILL.md", baseDir: "/skills/hidden", source: "user", disableModelInvocation: true },
    { name: "esc", description: "Uses <xml> & \"quotes\".", filePath: "/skills/esc/SKILL.md", baseDir: "/skills/esc", source: "user", disableModelInvocation: false },
  ];

  test("task session with tools, context files and skills", () => {
    expect(buildReinsSystemPrompt({ tools, contextFiles, skills, task: { title: "Fix login bug", description: "Users can't log in" }, isScratchSession: false }))
      .toBe(expected("task"));
  });
  test("task session without a description, builtins only", () => {
    expect(buildReinsSystemPrompt({ tools: tools.slice(0, 4), contextFiles: [], skills: [], task: { title: "T", description: null }, isScratchSession: false }))
      .toBe(expected("task-no-description"));
  });
  test("scratch session with tools, context files and skills", () => {
    expect(buildReinsSystemPrompt({ tools, contextFiles, skills, isScratchSession: true })).toBe(expected("scratch"));
  });
  test("scratch session, builtins only", () => {
    expect(buildReinsSystemPrompt({ tools: tools.slice(0, 4), contextFiles: [], skills: [], isScratchSession: true })).toBe(expected("scratch-bare"));
  });
});
