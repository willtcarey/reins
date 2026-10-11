import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutContextFiles, checkoutSkills } from "./checkout-environment.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reins-checkout-environment-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeFile(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, "utf-8");
}

const inTempDir = (cwd: string) => checkoutContextFiles(cwd).filter(file => file.path.startsWith(tempDir));

describe("checkoutContextFiles", () => {
  test("finds AGENTS.md in the checkout and its ancestors, root first, and nothing else", () => {
    const parent = join(tempDir, "workspace");
    const child = join(parent, "project");
    writeFile(parent, "AGENTS.md", "workspace-level");
    writeFile(child, "AGENTS.md", "project-level");
    writeFile(child, "CLAUDE.md", "not a context file");

    expect(inTempDir(child)).toEqual([
      { path: join(parent, "AGENTS.md"), content: "workspace-level" },
      { path: join(child, "AGENTS.md"), content: "project-level" },
    ]);
  });

  test("is empty when the checkout has none", () => {
    expect(inTempDir(tempDir)).toEqual([]);
  });
});

describe("checkoutSkills", () => {
  const skillsDir = () => join(tempDir, ".agents", "skills");

  test("finds the checkout's skills, nested ones too, with their names, descriptions and flags", () => {
    writeFile(join(skillsDir(), "my-skill"), "SKILL.md", "---\nname: my-skill\ndescription: A test skill.\n---\n\n# My Skill\n");
    writeFile(join(skillsDir(), "category", "nested-skill"), "SKILL.md", "---\nname: nested-skill\ndescription: Nested.\ndisable-model-invocation: true\n---\n");
    writeFile(join(skillsDir(), "fallback-name"), "SKILL.md", "---\ndescription: Uses its directory's name.\n---\n");

    expect(checkoutSkills(tempDir).toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "fallback-name", description: "Uses its directory's name.", filePath: join(skillsDir(), "fallback-name", "SKILL.md"), disableModelInvocation: false },
      { name: "my-skill", description: "A test skill.", filePath: join(skillsDir(), "my-skill", "SKILL.md"), disableModelInvocation: false },
      { name: "nested-skill", description: "Nested.", filePath: join(skillsDir(), "category", "nested-skill", "SKILL.md"), disableModelInvocation: true },
    ]);
  });

  test("skips skills without a description, node_modules, and a skill reached twice", () => {
    writeFile(join(skillsDir(), "no-desc"), "SKILL.md", "---\nname: no-desc\n---\n");
    writeFile(join(skillsDir(), "node_modules", "bad-skill"), "SKILL.md", "---\nname: bad-skill\ndescription: Skipped.\n---\n");
    writeFile(join(skillsDir(), "real"), "SKILL.md", "---\nname: real\ndescription: Once.\n---\n");
    symlinkSync(join(skillsDir(), "real"), join(skillsDir(), "linked"));

    expect(checkoutSkills(tempDir).map(skill => skill.name)).toEqual(["real"]);
  });

  test("is empty without a skills directory", () => {
    expect(checkoutSkills(tempDir)).toEqual([]);
  });
});
