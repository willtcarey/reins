import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandPrompt } from "../../runtimes/prompt.js";
import type { Skill } from "../../runtimes/resource-loader.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reins-prompt-expand-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createSkill(name: string, body: string, opts: { description?: string; withFrontmatter?: boolean } = {}): Skill {
  const description = opts.description ?? `${name} skill description`;
  const skillDir = join(tempDir, name);
  mkdirSync(skillDir, { recursive: true });
  const filePath = join(skillDir, "SKILL.md");

  const content = opts.withFrontmatter === false
    ? body
    : `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
  writeFileSync(filePath, content, "utf-8");

  return {
    name,
    description,
    filePath,
    baseDir: skillDir,
    source: "user",
    disableModelInvocation: false,
  };
}

describe("expandPrompt", () => {
  test("passes through when there are no slash tokens", () => {
    const skills = [createSkill("dip", "dip body")];
    const result = expandPrompt("just a plain message", skills);
    expect(result.expanded).toBe("just a plain message");
    expect(result.injected).toEqual([]);
  });

  test("passes through when no skills are known", () => {
    const result = expandPrompt("/dip hello", []);
    expect(result.expanded).toBe("/dip hello");
    expect(result.injected).toEqual([]);
  });

  test("injects a skill when the token is at the start of the message", () => {
    const skills = [createSkill("dip", "dip body content")];
    const result = expandPrompt("/dip start the server", skills);
    expect(result.expanded.startsWith('<skill name="dip"')).toBe(true);
    expect(result.expanded).toContain("dip body content");
    expect(result.expanded.endsWith("/dip start the server")).toBe(true);
    expect(result.injected).toHaveLength(1);
    expect(result.injected[0]).toMatchObject({ name: "dip", description: "dip skill description" });
  });

  test("injects a skill when the token is in the middle", () => {
    const skills = [createSkill("dip", "dip body")];
    const result = expandPrompt("please run /dip now", skills);
    expect(result.injected.map((i) => i.name)).toEqual(["dip"]);
    expect(result.expanded.endsWith("please run /dip now")).toBe(true);
  });

  test("injects a skill when the token is at the end", () => {
    const skills = [createSkill("tmux", "tmux body")];
    const result = expandPrompt("check session via /tmux", skills);
    expect(result.injected.map((i) => i.name)).toEqual(["tmux"]);
    expect(result.expanded.endsWith("check session via /tmux")).toBe(true);
  });

  test("injects multiple distinct skills in order of first appearance", () => {
    const skills = [
      createSkill("dip", "dip body"),
      createSkill("tmux", "tmux body"),
    ];
    const result = expandPrompt("/tmux then /dip please", skills);
    expect(result.injected.map((i) => i.name)).toEqual(["tmux", "dip"]);

    const tmuxIdx = result.expanded.indexOf('<skill name="tmux"');
    const dipIdx = result.expanded.indexOf('<skill name="dip"');
    expect(tmuxIdx).toBeGreaterThanOrEqual(0);
    expect(dipIdx).toBeGreaterThan(tmuxIdx);
  });

  test("dedups the same skill mentioned twice in a turn", () => {
    const skills = [createSkill("dip", "dip body")];
    const result = expandPrompt("/dip /dip foo", skills);
    expect(result.injected.map((i) => i.name)).toEqual(["dip"]);
    const matches = result.expanded.match(/<skill name="dip"/g) ?? [];
    expect(matches).toHaveLength(1);
    // User message text is unchanged
    expect(result.expanded.endsWith("/dip /dip foo")).toBe(true);
  });

  test("does not match path-like tokens", () => {
    const skills = [createSkill("dip", "dip body")];
    const result = expandPrompt("see docker/dip for details", skills);
    expect(result.injected).toEqual([]);
    expect(result.expanded).toBe("see docker/dip for details");
  });

  test("does not match glued tokens (e.g. /dipfoo)", () => {
    const skills = [createSkill("dip", "dip body")];
    const result = expandPrompt("/dipfoo is not a skill", skills);
    expect(result.injected).toEqual([]);
    expect(result.expanded).toBe("/dipfoo is not a skill");
  });

  test("does nothing for unknown skill names", () => {
    const skills = [createSkill("dip", "dip body")];
    const result = expandPrompt("/doesnotexist and /alsonope", skills);
    expect(result.injected).toEqual([]);
    expect(result.expanded).toBe("/doesnotexist and /alsonope");
  });

  test("strips YAML frontmatter from skill body", () => {
    const skills = [createSkill("dip", "actual body text")];
    const result = expandPrompt("/dip hello", skills);
    expect(result.expanded).toContain("actual body text");
    expect(result.expanded).not.toContain("name: dip");
    expect(result.expanded).not.toContain("description: dip skill description");
  });

  test("handles a file with no frontmatter", () => {
    const skills = [createSkill("raw", "no fm here", { withFrontmatter: false })];
    const result = expandPrompt("/raw go", skills);
    expect(result.expanded).toContain("no fm here");
  });

  test("skips skills whose file cannot be read and injects the rest", () => {
    const dip = createSkill("dip", "dip body");
    const broken: Skill = {
      name: "broken",
      description: "missing file",
      filePath: join(tempDir, "broken", "SKILL.md"),
      baseDir: join(tempDir, "broken"),
      source: "user",
      disableModelInvocation: false,
    };

    const result = expandPrompt("/broken and /dip please", [dip, broken]);
    expect(result.injected.map((i) => i.name)).toEqual(["dip"]);
    expect(result.expanded).toContain('<skill name="dip"');
    expect(result.expanded).not.toContain('<skill name="broken"');
  });

  test("wraps blocks with location and baseDir references", () => {
    const skills = [createSkill("dip", "body")];
    const result = expandPrompt("/dip", skills);
    expect(result.expanded).toContain(`<skill name="dip" location="${skills[0].filePath}">`);
    expect(result.expanded).toContain(`References are relative to ${skills[0].baseDir}.`);
    expect(result.expanded).toContain("</skill>");
  });
});
