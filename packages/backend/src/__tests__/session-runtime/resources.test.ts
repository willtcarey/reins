import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckoutEnvironmentResult } from "@reins/node-protocol";
import { mergeResources, serverResources, skillContent } from "../../session-runtime/resources.js";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "reins-server-agents-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

function writeFile(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, "utf-8");
}

const skill = (name: string, description: string, filePath: string, disableModelInvocation = false) =>
  ({ name, description, filePath, baseDir: join(filePath, ".."), disableModelInvocation });

describe("serverResources", () => {
  test("reads the server's AGENTS.md and its user skills: nested ones, root .md files, a name from the directory and the invocation flag", () => {
    const skills = join(agentDir, "skills");
    writeFile(agentDir, "AGENTS.md", "Server instructions");
    writeFile(join(skills, "my-skill"), "SKILL.md", "---\nname: my-skill\ndescription: A user skill.\n---\n\n# My Skill\n");
    writeFile(join(skills, "category", "nested-skill"), "SKILL.md", "---\nname: nested-skill\ndescription: Nested.\ndisable-model-invocation: true\n---\n");
    writeFile(join(skills, "fallback-name"), "SKILL.md", "---\ndescription: Uses its directory's name.\n---\n");
    writeFile(skills, "root-skill.md", "---\nname: root-skill\ndescription: A file at the root.\n---\n");

    const resources = serverResources(agentDir);
    expect(resources.contextFiles).toEqual([{ path: join(agentDir, "AGENTS.md"), content: "Server instructions" }]);
    expect(resources.skills.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      skill("fallback-name", "Uses its directory's name.", join(skills, "fallback-name", "SKILL.md")),
      skill("my-skill", "A user skill.", join(skills, "my-skill", "SKILL.md")),
      skill("nested-skill", "Nested.", join(skills, "category", "nested-skill", "SKILL.md"), true),
      skill("root-skill", "A file at the root.", join(skills, "root-skill.md")),
    ]);
  });

  test("skips skills without a description, node_modules, a second skill of a name and a skill reached twice", () => {
    const skills = join(agentDir, "skills");
    writeFile(join(skills, "no-desc"), "SKILL.md", "---\nname: no-desc\n---\n");
    writeFile(join(skills, "node_modules", "bad-skill"), "SKILL.md", "---\nname: bad-skill\ndescription: Skipped.\n---\n");
    writeFile(join(skills, "a"), "SKILL.md", "---\nname: dup\ndescription: First.\n---\n");
    writeFile(join(skills, "b"), "SKILL.md", "---\nname: dup\ndescription: Second.\n---\n");
    writeFile(join(skills, "real"), "SKILL.md", "---\nname: real\ndescription: Once.\n---\n");
    symlinkSync(join(skills, "real"), join(skills, "linked"));

    expect(serverResources(agentDir).skills.map(found => found.name).toSorted()).toEqual(["dup", "real"]);
  });

  test("is empty without an agents dir", () => {
    expect(serverResources(join(agentDir, "missing"))).toEqual({ contextFiles: [], skills: [] });
  });
});

const checkout = (fields: Partial<CheckoutEnvironmentResult> = {}): CheckoutEnvironmentResult =>
  ({ contextFiles: [], skills: [], docs: { dir: "/node/docs", devDocs: true }, ...fields });

describe("mergeResources", () => {
  test("the server's context files and skills come first: a checkout skill of a server skill's name is hidden, and a context file is listed once", () => {
    writeFile(agentDir, "AGENTS.md", "Server instructions");
    writeFile(join(agentDir, "skills", "shared"), "SKILL.md", "---\nname: shared\ndescription: The server's.\n---\nServer body");
    const merged = mergeResources(serverResources(agentDir), checkout({
      contextFiles: [{ path: join(agentDir, "AGENTS.md"), content: "Server instructions" }, { path: "/repo/AGENTS.md", content: "Checkout instructions" }],
      skills: [
        { name: "shared", description: "The checkout's.", path: "/repo/.agents/skills/shared/SKILL.md", disableModelInvocation: false, content: "Checkout body" },
        { name: "repo-only", description: "Only the checkout's.", path: "/repo/.agents/skills/repo-only/SKILL.md", disableModelInvocation: true, content: "---\nname: repo-only\n---\nRepo body" },
      ],
    }));

    expect(merged.contextFiles.map(file => file.content)).toEqual(["Server instructions", "Checkout instructions"]);
    expect(merged.skills.map(found => [found.name, found.description, found.baseDir])).toEqual([
      ["shared", "The server's.", join(agentDir, "skills", "shared")],
      ["repo-only", "Only the checkout's.", "/repo/.agents/skills/repo-only"],
    ]);
    expect(merged.skills[1]!.disableModelInvocation).toBe(true);
    expect(merged.docs).toEqual({ dir: "/node/docs", devDocs: true });
    // A server skill is read on the server; a checkout's comes with its content.
    expect(merged.skills.map(skillContent)).toEqual(["---\nname: shared\ndescription: The server's.\n---\nServer body", "---\nname: repo-only\n---\nRepo body"]);
  });
});
