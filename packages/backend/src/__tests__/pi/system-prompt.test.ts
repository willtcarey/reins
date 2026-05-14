import { describe, expect, test } from "bun:test";
import { buildReinsSystemPrompt } from "../../runtimes/system-prompt.js";

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
    expect(prompt).not.toContain("@mariozechner/pi-coding-agent");
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
    expect(prompt).toContain("Do not implement features or make substantial code changes");
    expect(prompt).toContain("create or use a dedicated task session/branch");
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
