import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { environmentPrompt, expandSkills } from "../../session-runtime/environment.js";
import type { SessionResources, Skill } from "../../session-runtime/resources.js";

// Fixtures pin the environment section as the node rendered it before sessions ran on the server, with
// the working directory line since added.
describe("environmentPrompt", () => {
  const expected = (name: string) => readFileSync(new URL(`../fixtures/system-prompt/${name}.txt`, import.meta.url), "utf8");
  const tools = [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" },
    { name: "execute", description: "Run a Reins script." }, { name: "search", description: "  Search the API.\n" }, { name: "create_task", description: "" }];
  const docs = { dir: "/reins/docs", devDocs: true };
  const resources = (fields: Partial<SessionResources> = {}): SessionResources => ({ contextFiles: [], skills: [], docs, ...fields });
  const cwd = "/project";

  test("names the session's working directory, then lists the offered tools, the node's REINS docs, context files and the skills the model may invoke", () => {
    const contextFiles = [{ path: "/project/AGENTS.md", content: "Follow these rules." }, { path: "/home/u/.reins/AGENTS.md", content: "Global rules.\nLine 2." }];
    const skills = [
      { name: "test-skill", description: "A test skill.", filePath: "/skills/test-skill/SKILL.md", content: "", disableModelInvocation: false },
      { name: "hidden", description: "Hidden <&>.", filePath: "/skills/hidden/SKILL.md", content: "", disableModelInvocation: true },
      { name: "esc", description: "Uses <xml> & \"quotes\".", filePath: "/skills/esc/SKILL.md", content: "", disableModelInvocation: false },
    ];
    expect(environmentPrompt({ cwd, tools, resources: resources({ contextFiles, skills }) })).toBe(expected("environment"));
  });

  test("without context files or skills, only the tools and docs", () => {
    expect(environmentPrompt({ cwd, tools: tools.slice(0, 4), resources: resources() })).toBe(expected("environment-bare"));
  });

  test("names the node's docs without a developer docs line when it has none (a delivered bundle's)", () => {
    expect(environmentPrompt({ cwd, tools: [], resources: resources({ docs: { dir: "/home/u/.reins/builds/b/docs", devDocs: false } }) })).toBe(`

Current working directory: /project

REINS documentation (read only when the user asks about REINS itself):
- Feature docs: /home/u/.reins/builds/b/docs/features
- Skills feature doc: /home/u/.reins/builds/b/docs/features/skills.md
- Skills are listed in <available_skills>; read a skill's SKILL.md only when the task matches.`);
  });

  test("lists no tools when none is offered, and no docs when the node did not say where they are", () => {
    expect(environmentPrompt({ cwd, tools: [], resources: resources() })).not.toContain("Available tools");
    expect(environmentPrompt({ cwd, tools: [], resources: resources({ docs: null }) })).toBe("\n\nCurrent working directory: /project");
  });
});

const skill = (name: string, filePath: string, content: string): Skill => ({ name, description: name, filePath, disableModelInvocation: false, content });
const text = (blocks: Awaited<ReturnType<typeof expandSkills>>) => blocks.find(block => block.type === "text")?.text;
const offline = async (): Promise<never> => { throw new Error("The node's skills are unavailable (node offline)"); };

describe("expandSkills", () => {
  test("each /name of a skill expands into a block before the content, the first text block's; names no skill has are left as they are", async () => {
    const skills = async () => [skill("repo-skill", "/repo/.agents/skills/repo-skill/SKILL.md", "REPO_BODY"), skill("mine", "/home/u/.agents/skills/mine/SKILL.md", "MINE_BODY")];
    expect(text(await expandSkills([{ type: "text", text: "/mine go" }], skills))).toBe(`<skill name="mine" location="/home/u/.agents/skills/mine/SKILL.md">
References are relative to /home/u/.agents/skills/mine.

MINE_BODY
</skill>

/mine go`);

    const both = text(await expandSkills([{ type: "text", text: "/repo-skill and /mine and /nobody" }], skills));
    expect(both).toStartWith(`<skill name="repo-skill" location="/repo/.agents/skills/repo-skill/SKILL.md">`);
    expect(both).toContain("MINE_BODY");
    expect(both).toEndWith("\n\n/repo-skill and /mine and /nobody");
  });

  test("content without a /name token is admitted as it is without asking the node; a node that cannot answer fails the expansion", async () => {
    const content = [{ type: "text" as const, text: "no skills here, a/path" }];
    expect(await expandSkills(content, offline)).toEqual(content);
    await expect(expandSkills([{ type: "text", text: "/repo-skill" }], offline)).rejects.toThrow("unavailable");
  });
});
