import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReinsResourceLoader,
  formatContextFilesForPrompt,
  formatSkillsForPrompt,
  type Skill,
} from "../../runtimes/resource-loader.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reins-resource-loader-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeFile(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, "utf-8");
}

function createLoader(cwd: string, agentDir?: string): ReinsResourceLoader {
  return new ReinsResourceLoader({ cwd, agentDir: agentDir ?? join(cwd, "nonexistent-agent-dir") });
}

// ---------------------------------------------------------------------------
// Context files
// ---------------------------------------------------------------------------

describe("ReinsResourceLoader — context files", () => {
  test("discovers AGENTS.md in cwd", () => {
    writeFile(tempDir, "AGENTS.md", "# Project instructions");
    const loader = createLoader(tempDir);
    expect(loader.contextFiles).toHaveLength(1);
    expect(loader.contextFiles[0].path).toBe(join(tempDir, "AGENTS.md"));
    expect(loader.contextFiles[0].content).toBe("# Project instructions");
  });

  test("ignores CLAUDE.md (only AGENTS.md is supported)", () => {
    writeFile(tempDir, "CLAUDE.md", "# Claude instructions");
    const loader = createLoader(tempDir);
    const inTempDir = loader.contextFiles.filter((f) => f.path.startsWith(tempDir));
    expect(inTempDir).toHaveLength(0);
  });

  test("includes global agent dir context file", () => {
    const agentDir = join(tempDir, "global-agent");
    writeFile(agentDir, "AGENTS.md", "global instructions");

    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const loader = new ReinsResourceLoader({ cwd: projectDir, agentDir });
    expect(loader.contextFiles).toHaveLength(1);
    expect(loader.contextFiles[0].content).toBe("global instructions");
  });

  test("global context comes before project context", () => {
    const agentDir = join(tempDir, "global-agent");
    writeFile(agentDir, "AGENTS.md", "global");

    const projectDir = join(tempDir, "project");
    writeFile(projectDir, "AGENTS.md", "project");

    const loader = new ReinsResourceLoader({ cwd: projectDir, agentDir });
    expect(loader.contextFiles).toHaveLength(2);
    expect(loader.contextFiles[0].content).toBe("global");
    expect(loader.contextFiles[1].content).toBe("project");
  });

  test("discovers ancestor directory context files", () => {
    const parent = join(tempDir, "workspace");
    const child = join(parent, "project");
    writeFile(parent, "AGENTS.md", "workspace-level");
    writeFile(child, "AGENTS.md", "project-level");
    mkdirSync(child, { recursive: true });

    const loader = createLoader(child);
    const inTempDir = loader.contextFiles.filter((f) => f.path.startsWith(tempDir));
    expect(inTempDir).toHaveLength(2);
    expect(inTempDir[0].content).toBe("workspace-level");
    expect(inTempDir[1].content).toBe("project-level");
  });

  test("returns empty array when no context files exist", () => {
    const loader = createLoader(tempDir);
    const inTempDir = loader.contextFiles.filter((f) => f.path.startsWith(tempDir));
    expect(inTempDir).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

describe("ReinsResourceLoader — skills", () => {
  test("discovers skills from project .agents/skills/ directory", () => {
    const skillDir = join(tempDir, ".agents", "skills", "my-skill");
    writeFile(skillDir, "SKILL.md", [
      "---",
      "name: my-skill",
      "description: A test skill for unit tests.",
      "---",
      "",
      "# My Skill",
      "Do the thing.",
    ].join("\n"));

    const loader = createLoader(tempDir);
    expect(loader.skills).toHaveLength(1);
    expect(loader.skills[0].name).toBe("my-skill");
    expect(loader.skills[0].description).toBe("A test skill for unit tests.");
    expect(loader.skills[0].filePath).toBe(join(skillDir, "SKILL.md"));
    expect(loader.skills[0].source).toBe("project");
  });

  test("discovers skills from global agent skills directory", () => {
    const agentDir = join(tempDir, "global-agent");
    const skillDir = join(agentDir, "skills", "global-skill");
    writeFile(skillDir, "SKILL.md", [
      "---",
      "name: global-skill",
      "description: A global skill.",
      "---",
      "# Global",
    ].join("\n"));

    const loader = new ReinsResourceLoader({ cwd: tempDir, agentDir });
    expect(loader.skills).toHaveLength(1);
    expect(loader.skills[0].name).toBe("global-skill");
    expect(loader.skills[0].source).toBe("user");
  });

  test("skips skills without a description", () => {
    const skillDir = join(tempDir, ".agents", "skills", "no-desc");
    writeFile(skillDir, "SKILL.md", [
      "---",
      "name: no-desc",
      "---",
      "# No Description",
    ].join("\n"));

    const loader = createLoader(tempDir);
    expect(loader.skills).toHaveLength(0);
    expect(loader.diagnostics.some((d) => d.message === "description is required")).toBe(true);
  });

  test("deduplicates skills by name (first wins)", () => {
    const agentDir = join(tempDir, "global-agent");
    const globalSkillDir = join(agentDir, "skills", "dup-skill");
    const projectSkillDir = join(tempDir, ".agents", "skills", "dup-skill");

    writeFile(globalSkillDir, "SKILL.md", "---\nname: dup-skill\ndescription: Global version.\n---\n");
    writeFile(projectSkillDir, "SKILL.md", "---\nname: dup-skill\ndescription: Project version.\n---\n");

    const loader = new ReinsResourceLoader({ cwd: tempDir, agentDir });
    expect(loader.skills).toHaveLength(1);
    expect(loader.skills[0].description).toBe("Global version.");
    expect(loader.diagnostics.some((d) => d.type === "collision")).toBe(true);
  });

  test("handles disable-model-invocation flag", () => {
    const skillDir = join(tempDir, ".agents", "skills", "hidden-skill");
    writeFile(skillDir, "SKILL.md", [
      "---",
      "name: hidden-skill",
      "description: A hidden skill.",
      "disable-model-invocation: true",
      "---",
    ].join("\n"));

    const loader = createLoader(tempDir);
    expect(loader.skills).toHaveLength(1);
    expect(loader.skills[0].disableModelInvocation).toBe(true);
  });

  test("returns empty when no skills directories exist", () => {
    const loader = createLoader(tempDir);
    expect(loader.skills).toHaveLength(0);
  });

  test("recurses into subdirectories to find SKILL.md", () => {
    const nestedDir = join(tempDir, ".agents", "skills", "category", "nested-skill");
    writeFile(nestedDir, "SKILL.md", "---\nname: nested-skill\ndescription: Nested.\n---\n");

    const loader = createLoader(tempDir);
    expect(loader.skills).toHaveLength(1);
    expect(loader.skills[0].name).toBe("nested-skill");
  });

  test("skips node_modules directories", () => {
    const nmDir = join(tempDir, ".agents", "skills", "node_modules", "bad-skill");
    writeFile(nmDir, "SKILL.md", "---\nname: bad-skill\ndescription: Should be skipped.\n---\n");

    const loader = createLoader(tempDir);
    expect(loader.skills).toHaveLength(0);
  });

  test("falls back to parent directory name when frontmatter name is missing", () => {
    const skillDir = join(tempDir, ".agents", "skills", "fallback-name");
    writeFile(skillDir, "SKILL.md", "---\ndescription: Uses dir name.\n---\n");

    const loader = createLoader(tempDir);
    expect(loader.skills).toHaveLength(1);
    expect(loader.skills[0].name).toBe("fallback-name");
  });
});

// ---------------------------------------------------------------------------
// Lazy loading
// ---------------------------------------------------------------------------

describe("ReinsResourceLoader — lazy loading", () => {
  test("loads automatically on first property access", () => {
    writeFile(tempDir, "AGENTS.md", "# Auto-loaded");
    const loader = createLoader(tempDir);
    // No explicit load() call
    expect(loader.contextFiles).toHaveLength(1);
  });

  test("reload() picks up new files", () => {
    const loader = createLoader(tempDir);
    expect(loader.contextFiles.filter((f) => f.path.startsWith(tempDir))).toHaveLength(0);

    writeFile(tempDir, "AGENTS.md", "# Added later");
    loader.load();
    expect(loader.contextFiles.filter((f) => f.path.startsWith(tempDir))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe("formatSkillsForPrompt", () => {
  test("formats skills as XML", () => {
    const skills: Skill[] = [{
      name: "test-skill",
      description: "A test skill.",
      filePath: "/path/to/SKILL.md",
      baseDir: "/path/to",
      source: "project",
      disableModelInvocation: false,
    }];

    const result = formatSkillsForPrompt(skills);
    expect(result).toContain("<available_skills>");
    expect(result).toContain("<name>test-skill</name>");
    expect(result).toContain("<description>A test skill.</description>");
    expect(result).toContain("<location>/path/to/SKILL.md</location>");
    expect(result).toContain("</available_skills>");
  });

  test("excludes skills with disableModelInvocation", () => {
    const skills: Skill[] = [{
      name: "hidden",
      description: "Hidden.",
      filePath: "/path",
      baseDir: "/",
      source: "project",
      disableModelInvocation: true,
    }];

    const result = formatSkillsForPrompt(skills);
    expect(result).toBe("");
  });

  test("returns empty string when no skills", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });

  test("escapes XML special characters", () => {
    const skills: Skill[] = [{
      name: "xml-test",
      description: 'Has <special> & "chars"',
      filePath: "/path",
      baseDir: "/",
      source: "project",
      disableModelInvocation: false,
    }];

    const result = formatSkillsForPrompt(skills);
    expect(result).toContain("&lt;special&gt;");
    expect(result).toContain("&amp;");
    expect(result).toContain("&quot;chars&quot;");
  });
});

describe("formatContextFilesForPrompt", () => {
  test("formats context files as markdown sections", () => {
    const files = [
      { path: "/project/AGENTS.md", content: "Do this." },
      { path: "/global/AGENTS.md", content: "And this." },
    ];

    const result = formatContextFilesForPrompt(files);
    expect(result).toContain("# Project Context");
    expect(result).toContain("## /project/AGENTS.md");
    expect(result).toContain("Do this.");
    expect(result).toContain("## /global/AGENTS.md");
    expect(result).toContain("And this.");
  });

  test("returns empty string for no files", () => {
    expect(formatContextFilesForPrompt([])).toBe("");
  });
});
