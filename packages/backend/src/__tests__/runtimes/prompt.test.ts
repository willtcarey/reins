import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTestDb } from "../helpers/test-db.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import type { ClientPromptContent } from "../../messages-store.js";
import { stripLeadingSkillBlocks } from "../../models/skill.js";
import { expandPrompt, expandPromptWithSkills } from "../../runtimes/prompt.js";

let tempDir: string;

/** Isolate tests from the user's real `~/.agents/skills`. */
const NONEXISTENT_AGENT_DIR = "/tmp/reins-prompt-test-nonexistent-agent-dir";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reins-prompt-expand-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Drop a SKILL.md into the project's `.agents/skills/<name>/` directory so
 * it can be picked up by `ReinsResourceLoader`.
 */
function createSkill(
  name: string,
  body: string,
  skillOpts: { description?: string; withFrontmatter?: boolean } = {},
): { name: string; description: string; filePath: string; baseDir: string } {
  const description = skillOpts.description ?? `${name} skill description`;
  const skillDir = join(tempDir, ".agents", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  const filePath = join(skillDir, "SKILL.md");

  const content = skillOpts.withFrontmatter === false
    ? body
    : `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
  writeFileSync(filePath, content, "utf-8");

  return { name, description, filePath, baseDir: skillDir };
}

function opts() {
  return { cwd: tempDir, agentDir: NONEXISTENT_AGENT_DIR };
}

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

describe("expandPromptWithSkills", () => {
  test("passes through when there are no slash tokens", () => {
    createSkill("dip", "dip body");
    const result = expandPromptWithSkills(textPrompt("just a plain message"), opts());
    expect(result.expanded).toEqual(textPrompt("just a plain message"));
    expect(result.injected).toEqual([]);
  });

  test("passes through when no skills are known", () => {
    const result = expandPromptWithSkills(textPrompt("/dip hello"), opts());
    expect(result.expanded).toEqual(textPrompt("/dip hello"));
    expect(result.injected).toEqual([]);
  });

  test("injects a skill when the token is at the start of the message", () => {
    createSkill("dip", "dip body content");
    const result = expandPromptWithSkills(textPrompt("/dip start the server"), opts());
    expect(expandedText(result).startsWith('<skill name="dip"')).toBe(true);
    expect(expandedText(result)).toContain("dip body content");
    expect(expandedText(result).endsWith("/dip start the server")).toBe(true);
    expect(result.injected).toHaveLength(1);
    expect(result.injected[0]).toMatchObject({ name: "dip", description: "dip skill description" });
  });

  test("injects skills into the first text block without disturbing image refs", () => {
    createSkill("dip", "dip body content");
    const imageBlock = { type: "image" as const, attachmentId: "att_1", mimeType: "image/png", byteSize: 123 };
    const message: ClientPromptContent = [
      { type: "text", text: "/dip what is in this screenshot?" },
      imageBlock,
    ];

    const result = expandPromptWithSkills(message, opts());

    if (!Array.isArray(result.expanded)) {
      throw new Error("Expected expanded prompt to be content blocks");
    }
    const expanded = result.expanded;
    expect(expanded[0]).toMatchObject({ type: "text" });
    if (expanded[0]?.type === "text") {
      expect(expanded[0].text).toContain("dip body content");
      expect(expanded[0].text.endsWith("/dip what is in this screenshot?")).toBe(true);
    }
    expect(expanded[1]).toEqual(imageBlock);
    expect(result.injected.map((skill) => skill.name)).toEqual(["dip"]);
  });

  test("injects a skill when the token is in the middle", () => {
    createSkill("dip", "dip body");
    const result = expandPromptWithSkills(textPrompt("please run /dip now"), opts());
    expect(result.injected.map((i) => i.name)).toEqual(["dip"]);
    expect(expandedText(result).endsWith("please run /dip now")).toBe(true);
  });

  test("injects a skill when the token is at the end", () => {
    createSkill("tmux", "tmux body");
    const result = expandPromptWithSkills(textPrompt("check session via /tmux"), opts());
    expect(result.injected.map((i) => i.name)).toEqual(["tmux"]);
    expect(expandedText(result).endsWith("check session via /tmux")).toBe(true);
  });

  test("injects multiple distinct skills in order of first appearance", () => {
    createSkill("dip", "dip body");
    createSkill("tmux", "tmux body");
    const result = expandPromptWithSkills(textPrompt("/tmux then /dip please"), opts());
    expect(result.injected.map((i) => i.name)).toEqual(["tmux", "dip"]);

    const tmuxIdx = expandedText(result).indexOf('<skill name="tmux"');
    const dipIdx = expandedText(result).indexOf('<skill name="dip"');
    expect(tmuxIdx).toBeGreaterThanOrEqual(0);
    expect(dipIdx).toBeGreaterThan(tmuxIdx);
  });

  test("re-injects on duplicate invocations within a turn", () => {
    createSkill("dip", "dip body");
    const result = expandPromptWithSkills(textPrompt("/dip /dip foo"), opts());
    expect(result.injected.map((i) => i.name)).toEqual(["dip", "dip"]);
    const matches = expandedText(result).match(/<skill name="dip"/g) ?? [];
    expect(matches).toHaveLength(2);
    // User message text is unchanged
    expect(expandedText(result).endsWith("/dip /dip foo")).toBe(true);
  });

  test("does not match path-like tokens", () => {
    createSkill("dip", "dip body");
    const result = expandPromptWithSkills(textPrompt("see docker/dip for details"), opts());
    expect(result.injected).toEqual([]);
    expect(result.expanded).toEqual(textPrompt("see docker/dip for details"));
  });

  test("does not match glued tokens (e.g. /dipfoo)", () => {
    createSkill("dip", "dip body");
    const result = expandPromptWithSkills(textPrompt("/dipfoo is not a skill"), opts());
    expect(result.injected).toEqual([]);
    expect(result.expanded).toEqual(textPrompt("/dipfoo is not a skill"));
  });

  test("does nothing for unknown skill names", () => {
    createSkill("dip", "dip body");
    const result = expandPromptWithSkills(textPrompt("/doesnotexist and /alsonope"), opts());
    expect(result.injected).toEqual([]);
    expect(result.expanded).toEqual(textPrompt("/doesnotexist and /alsonope"));
  });

  test("strips YAML frontmatter from skill body", () => {
    createSkill("dip", "actual body text");
    const result = expandPromptWithSkills(textPrompt("/dip hello"), opts());
    expect(expandedText(result)).toContain("actual body text");
    expect(expandedText(result)).not.toContain("name: dip");
    expect(expandedText(result)).not.toContain("description: dip skill description");
  });

  test("handles a file with no frontmatter", () => {
    // A SKILL.md with no frontmatter has no description, so the loader will
    // not register it — use a neighbor skill with frontmatter to verify the
    // loader tolerates a raw file in the tree without failing.
    createSkill("dip", "frontmatter body");
    writeFileSync(
      join(tempDir, ".agents", "skills", "README.md"),
      "plain docs with no frontmatter",
      "utf-8",
    );
    const result = expandPromptWithSkills(textPrompt("/dip go"), opts());
    expect(expandedText(result)).toContain("frontmatter body");
  });

  test("wraps blocks with location and baseDir references", () => {
    const skill = createSkill("dip", "body");
    const result = expandPromptWithSkills(textPrompt("/dip"), opts());
    expect(expandedText(result)).toContain(`<skill name="dip" location="${skill.filePath}">`);
    expect(expandedText(result)).toContain(`References are relative to ${skill.baseDir}.`);
    expect(expandedText(result)).toContain("</skill>");
  });
});

describe("expandPrompt (session-based wrapper)", () => {
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
