import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { checkoutResources, mergeResources, serverResources, type Resources } from "../../session-runtime/resources.js";

let root: string;
let agentDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reins-resources-"));
  agentDir = join(root, "home", ".agents");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFile(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, "utf-8");
}

const skill = (name: string, description: string, filePath: string, content: string, disableModelInvocation = false) =>
  ({ name, description, filePath, content, disableModelInvocation });

describe("serverResources", () => {
  test("reads the server's AGENTS.md and its user skills with their content: nested ones, root .md files, a name from the directory and the invocation flag", async () => {
    const skills = join(agentDir, "skills");
    writeFile(agentDir, "AGENTS.md", "Server instructions");
    writeFile(join(skills, "my-skill"), "SKILL.md", "---\nname: my-skill\ndescription: A user skill.\n---\n\n# My Skill\n");
    writeFile(join(skills, "category", "nested-skill"), "SKILL.md", "---\nname: nested-skill\ndescription: Nested.\ndisable-model-invocation: true\n---\n");
    writeFile(join(skills, "fallback-name"), "SKILL.md", "---\ndescription: Uses its directory's name.\n---\n");
    writeFile(skills, "root-skill.md", "---\nname: root-skill\ndescription: A file at the root.\n---\n");

    const resources = await serverResources(agentDir);
    expect(resources.contextFiles).toEqual([{ path: join(agentDir, "AGENTS.md"), content: "Server instructions" }]);
    expect(resources.skills.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      skill("fallback-name", "Uses its directory's name.", join(skills, "fallback-name", "SKILL.md"), ""),
      skill("my-skill", "A user skill.", join(skills, "my-skill", "SKILL.md"), "# My Skill"),
      skill("nested-skill", "Nested.", join(skills, "category", "nested-skill", "SKILL.md"), "", true),
      skill("root-skill", "A file at the root.", join(skills, "root-skill.md"), ""),
    ]);
  });

  test("skips skills without a description, node_modules, a second skill of a name and a skill reached twice", async () => {
    const skills = join(agentDir, "skills");
    writeFile(join(skills, "no-desc"), "SKILL.md", "---\nname: no-desc\n---\n");
    writeFile(join(skills, "node_modules", "bad-skill"), "SKILL.md", "---\nname: bad-skill\ndescription: Skipped.\n---\n");
    writeFile(join(skills, "a"), "SKILL.md", "---\nname: dup\ndescription: First.\n---\n");
    writeFile(join(skills, "b"), "SKILL.md", "---\nname: dup\ndescription: Second.\n---\n");
    writeFile(join(skills, "real"), "SKILL.md", "---\nname: real\ndescription: Once.\n---\n");
    symlinkSync(join(skills, "real"), join(skills, "linked"));

    const found = (await serverResources(agentDir)).skills;
    expect(found.map(each => each.name).toSorted()).toEqual(["dup", "real"]);
    expect(found.find(each => each.name === "dup")!.description).toBe("First.");
  });

  test("is empty without an agents dir", async () => {
    expect(await serverResources(join(agentDir, "missing"))).toEqual({ contextFiles: [], skills: [] });
  });
});

describe("checkoutResources", () => {
  test("the AGENTS.md files of the checkout and its ancestors, root first, and the skills of its .agents/skills: nothing of anyone's ~/.agents", async () => {
    const cwd = join(root, "workspace", "project");
    writeFile(agentDir, "AGENTS.md", "the home's own instructions");
    writeFile(join(agentDir, "skills", "mine"), "SKILL.md", "---\nname: mine\ndescription: The home's own\n---\n");
    writeFile(join(root, "workspace"), "AGENTS.md", "workspace instructions");
    writeFile(cwd, "AGENTS.md", "project instructions");
    writeFile(join(cwd, ".agents", "skills", "review"), "SKILL.md", "---\nname: review\ndescription: Reviews code\ndisable-model-invocation: true\n---\n\nRead the diff.");

    const resources = await checkoutResources(new NodeExecutionEnv({ cwd }), BACKGROUND_CONTEXT);
    expect(resources.contextFiles.filter(file => file.path.startsWith(root))).toEqual([
      { path: join(root, "workspace", "AGENTS.md"), content: "workspace instructions" },
      { path: join(cwd, "AGENTS.md"), content: "project instructions" },
    ]);
    expect(resources.skills).toEqual([skill("review", "Reviews code", join(cwd, ".agents", "skills", "review", "SKILL.md"), "Read the diff.", true)]);
  });

  test("a discovery cut short by its signal rejects, rather than pass for a checkout without resources", async () => {
    const cwd = join(root, "project");
    writeFile(cwd, "AGENTS.md", "project instructions");
    await expect(checkoutResources(new NodeExecutionEnv({ cwd }), withAbortSignal(AbortSignal.abort(new Error("gave up")), BACKGROUND_CONTEXT))).rejects.toThrow("gave up");
  });
});

describe("mergeResources", () => {
  test("the server's context files and skills come first: a checkout skill of a server skill's name is hidden, and a context file is listed once", async () => {
    writeFile(agentDir, "AGENTS.md", "Server instructions");
    writeFile(join(agentDir, "skills", "shared"), "SKILL.md", "---\nname: shared\ndescription: The server's.\n---\nServer body");
    const checkout: Resources = {
      contextFiles: [{ path: join(agentDir, "AGENTS.md"), content: "Server instructions" }, { path: "/repo/AGENTS.md", content: "Checkout instructions" }],
      skills: [
        skill("shared", "The checkout's.", "/repo/.agents/skills/shared/SKILL.md", "Checkout body"),
        skill("repo-only", "Only the checkout's.", "/repo/.agents/skills/repo-only/SKILL.md", "Repo body", true),
      ],
    };
    const merged = mergeResources(await serverResources(agentDir), checkout, { dir: "/node/docs", devDocs: true });

    expect(merged.contextFiles.map(file => file.content)).toEqual(["Server instructions", "Checkout instructions"]);
    expect(merged.skills.map(found => [found.name, found.description, found.content])).toEqual([
      ["shared", "The server's.", "Server body"],
      ["repo-only", "Only the checkout's.", "Repo body"],
    ]);
    expect(merged.skills[1]!.disableModelInvocation).toBe(true);
    expect(merged.docs).toEqual({ dir: "/node/docs", devDocs: true });
  });
});
