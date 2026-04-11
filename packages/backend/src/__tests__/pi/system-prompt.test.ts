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
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("docs/dev");
    expect(prompt).toContain("docs/features");
    expect(prompt).toContain("docs/features/skills.md");
    expect(prompt).not.toContain("@mariozechner/pi-coding-agent");
    expect(prompt).not.toContain("extensions");
    expect(prompt).not.toContain("themes");
    expect(prompt).not.toContain("TUI");
  });
});
