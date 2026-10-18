import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { checkoutResources, nodeResources } from "../../session-runtime/resources.js";

let root: string;
let home: string;
let agentDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reins-resources-"));
  home = join(root, "home");
  agentDir = join(home, ".agents");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFile(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, "utf-8");
}

/** A node whose home is `home`: Pi resolves `~` with `os.homedir()`, which this test process cannot move. */
class NodeAt extends NodeExecutionEnv {
  constructor(cwd: string, private readonly nodeHome: string) { super({ cwd }); }
  override absolutePath(path: string, context: Context) {
    return super.absolutePath(path === "~" || path.startsWith("~/") ? join(this.nodeHome, path.slice(1)) : path, context);
  }
}
/** A checkout with nothing of its own on a node whose home is `home`. */
const emptyCheckout = () => { const cwd = join(root, "empty"); mkdirSync(cwd, { recursive: true }); return new NodeAt(cwd, home); };

const skill = (name: string, description: string, filePath: string, content: string, disableModelInvocation = false) =>
  ({ name, description, filePath, content, disableModelInvocation });

describe("nodeResources: the node's ~/.agents", () => {
  test("reads the node's ~/.agents/AGENTS.md and its user skills with their content: nested ones, root .md files, a name from the directory and the invocation flag", async () => {
    const skills = join(agentDir, "skills");
    writeFile(agentDir, "AGENTS.md", "Node instructions");
    writeFile(join(skills, "my-skill"), "SKILL.md", "---\nname: my-skill\ndescription: A user skill.\n---\n\n# My Skill\n");
    writeFile(join(skills, "category", "nested-skill"), "SKILL.md", "---\nname: nested-skill\ndescription: Nested.\ndisable-model-invocation: true\n---\n");
    writeFile(join(skills, "fallback-name"), "SKILL.md", "---\ndescription: Uses its directory's name.\n---\n");
    writeFile(skills, "root-skill.md", "---\nname: root-skill\ndescription: A file at the root.\n---\n");

    const resources = await nodeResources(emptyCheckout(), BACKGROUND_CONTEXT);
    expect(resources.contextFiles.filter(file => file.path.startsWith(root))).toEqual([{ path: join(agentDir, "AGENTS.md"), content: "Node instructions" }]);
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

    const found = (await nodeResources(emptyCheckout(), BACKGROUND_CONTEXT)).skills;
    expect(found.map(each => each.name).toSorted()).toEqual(["dup", "real"]);
    expect(found.find(each => each.name === "dup")!.description).toBe("First.");
  });

  test("is empty without an agents dir", async () => {
    const found = await nodeResources(emptyCheckout(), BACKGROUND_CONTEXT);
    expect({ ...found, contextFiles: found.contextFiles.filter(file => file.path.startsWith(root)) }).toEqual({ contextFiles: [], skills: [] });
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

describe("nodeResources: merged", () => {
  test("~/.agents comes first: its AGENTS.md before the checkout's, and a checkout skill of the same name is hidden", async () => {
    const cwd = join(home, "project");
    writeFile(agentDir, "AGENTS.md", "Node instructions");
    writeFile(join(agentDir, "skills", "shared"), "SKILL.md", "---\nname: shared\ndescription: The node's.\n---\nNode body");
    writeFile(cwd, "AGENTS.md", "Checkout instructions");
    writeFile(join(cwd, ".agents", "skills", "shared"), "SKILL.md", "---\nname: shared\ndescription: The checkout's.\n---\nCheckout body");
    writeFile(join(cwd, ".agents", "skills", "repo-only"), "SKILL.md", "---\nname: repo-only\ndescription: Only the checkout's.\ndisable-model-invocation: true\n---\nRepo body");

    const merged = await nodeResources(new NodeAt(cwd, home), BACKGROUND_CONTEXT);
    expect(merged.contextFiles.filter(file => file.path.startsWith(root)).map(file => file.content)).toEqual(["Node instructions", "Checkout instructions"]);
    expect(merged.skills.map(found => [found.name, found.description, found.content, found.disableModelInvocation])).toEqual([
      ["shared", "The node's.", "Node body", false],
      ["repo-only", "Only the checkout's.", "Repo body", true],
    ]);
  });

  test("a checkout whose .agents is ~/.agents (the node's home) lists its skills once", async () => {
    writeFile(home, "AGENTS.md", "Home instructions");
    writeFile(join(agentDir, "skills", "mine"), "SKILL.md", "---\nname: mine\ndescription: Mine.\n---\n");
    const merged = await nodeResources(new NodeAt(home, home), BACKGROUND_CONTEXT);
    expect(merged.skills.map(found => found.name)).toEqual(["mine"]);
    expect(merged.contextFiles.filter(file => file.path.startsWith(root)).map(file => file.content)).toEqual(["Home instructions"]);
  });
});
