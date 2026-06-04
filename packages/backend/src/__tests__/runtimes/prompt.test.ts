import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTestDb } from "../helpers/test-db.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import type { ClientPromptContent } from "../../messages-store.js";
import { stripLeadingSkillBlocks } from "../../models/skill.js";
import { expandPrompt } from "../../runtimes/prompt.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reins-prompt-expand-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function textPrompt(text: string): ClientPromptContent {
  return [{ type: "text", text }];
}

function expandedText(result: { expanded: ClientPromptContent }): string {
  const block = result.expanded.find((entry) => entry.type === "text");
  if (!block) {
    throw new Error("Expected expanded prompt to contain a text block");
  }
  return block.text;
}

describe("expandPrompt", () => {
  useTestDb();

  function createSessionForProject(projectDir: string): string {
    const project = createProject("prompt-expand-fixture", projectDir, "main");
    const sessionId = crypto.randomUUID();
    createSession(sessionId, project.id, { agentRuntimeType: "pi" });
    return sessionId;
  }

  test("returns message unchanged when the session cannot be resolved", () => {
    const result = expandPrompt(textPrompt("/unknown please"), "no-such-session");
    expect(result.expanded).toEqual(textPrompt("/unknown please"));
    expect(result.injected).toEqual([]);
  });

  test("resolves the project and expands matching skills", () => {
    // Use a unique name to avoid collisions with real user-global skills.
    const skillName = "reins-prompt-test-fixture";
    const skillDir = join(tempDir, ".agents", "skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: fixture skill description\n---\n\nfixture body content`,
      "utf-8",
    );

    const sessionId = createSessionForProject(tempDir);
    const message = `/${skillName} start the server`;
    const result = expandPrompt(textPrompt(message), sessionId);
    expect(result.injected.map((i) => i.name)).toEqual([skillName]);
    expect(expandedText(result)).toContain("fixture body content");
    expect(expandedText(result).endsWith(message)).toBe(true);
  });

  test("returns message unchanged when the token does not match any known skill", () => {
    const sessionId = createSessionForProject(tempDir);
    const result = expandPrompt(textPrompt("/doesnotexist please"), sessionId);
    expect(result.expanded).toEqual(textPrompt("/doesnotexist please"));
    expect(result.injected).toEqual([]);
  });
});

describe("stripLeadingSkillBlocks", () => {
  test("returns null for null input", () => {
    expect(stripLeadingSkillBlocks(null)).toBeNull();
  });

  test("returns empty string unchanged", () => {
    expect(stripLeadingSkillBlocks("")).toBe("");
  });

  test("returns plain text unchanged", () => {
    expect(stripLeadingSkillBlocks("hello")).toBe("hello");
  });

  test("strips a single leading block followed by text", () => {
    const input = `<skill name="dip" location="/x">body</skill>\n\n/dip start the server`;
    expect(stripLeadingSkillBlocks(input)).toBe("/dip start the server");
  });

  test("strips multiple consecutive leading blocks", () => {
    const input =
      `<skill name="dip" location="/x">dip body</skill>\n\n` +
      `<skill name="tmux" location="/y">tmux body</skill>\n\n` +
      `/tmux then /dip please`;
    expect(stripLeadingSkillBlocks(input)).toBe("/tmux then /dip please");
  });

  test("leaves blocks alone when they are not at the very start", () => {
    const input = `intro text <skill name="dip" location="/x">body</skill> trailing`;
    expect(stripLeadingSkillBlocks(input)).toBe(input);
  });

  test("strips a block with a multi-line body", () => {
    const input =
      `<skill name="dip" location="/x">\nline 1\nline 2\n\nline 4\n</skill>\n\nvisible`;
    expect(stripLeadingSkillBlocks(input)).toBe("visible");
  });
});
