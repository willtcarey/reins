import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { environmentPrompt, expandSkills } from "../../session-runtime/environment.js";
import type { ServerResources, SessionResources, Skill } from "../../session-runtime/resources.js";

// Fixtures pin the environment section as the node rendered it before sessions ran on the server.
describe("environmentPrompt", () => {
  const expected = (name: string) => readFileSync(new URL(`../fixtures/system-prompt/${name}.txt`, import.meta.url), "utf8");
  const tools = [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" },
    { name: "execute", description: "Run a Reins script." }, { name: "search", description: "  Search the API.\n" }, { name: "create_task", description: "" }];
  const docs = { dir: "/reins/docs", devDocs: true };
  const resources = (fields: Partial<SessionResources> = {}): SessionResources => ({ contextFiles: [], skills: [], docs, ...fields });

  test("lists the offered tools, the node's REINS docs, then context files and the skills the model may invoke", () => {
    const contextFiles = [{ path: "/project/AGENTS.md", content: "Follow these rules." }, { path: "/home/u/.reins/AGENTS.md", content: "Global rules.\nLine 2." }];
    const skills = [
      { name: "test-skill", description: "A test skill.", filePath: "/skills/test-skill/SKILL.md", baseDir: "/skills/test-skill", disableModelInvocation: false },
      { name: "hidden", description: "Hidden <&>.", filePath: "/skills/hidden/SKILL.md", baseDir: "/skills/hidden", disableModelInvocation: true },
      { name: "esc", description: "Uses <xml> & \"quotes\".", filePath: "/skills/esc/SKILL.md", baseDir: "/skills/esc", disableModelInvocation: false },
    ];
    expect(environmentPrompt({ tools, resources: resources({ contextFiles, skills }) })).toBe(expected("environment"));
  });

  test("without context files or skills, only the tools and docs", () => {
    expect(environmentPrompt({ tools: tools.slice(0, 4), resources: resources() })).toBe(expected("environment-bare"));
  });

  test("names the node's docs without a developer docs line when it has none (a delivered bundle's)", () => {
    expect(environmentPrompt({ tools: [], resources: resources({ docs: { dir: "/home/u/.reins/builds/b/docs", devDocs: false } }) })).toBe(`

REINS documentation (read only when the user asks about REINS itself):
- Feature docs: /home/u/.reins/builds/b/docs/features
- Skills feature doc: /home/u/.reins/builds/b/docs/features/skills.md
- Skills are listed in <available_skills>; read a skill's SKILL.md only when the task matches.`);
  });

  test("lists no tools when none is offered", () => {
    expect(environmentPrompt({ tools: [], resources: resources() })).not.toContain("Available tools");
  });
});

const skill = (name: string, filePath: string, content: string): Skill =>
  ({ name, description: name, filePath, baseDir: filePath.slice(0, filePath.lastIndexOf("/")), disableModelInvocation: false, content });
const text = (blocks: Awaited<ReturnType<typeof expandSkills>>) => blocks.find(block => block.type === "text")?.text;
const offline = async (): Promise<never> => { throw new Error("The checkout's skills are unavailable (node offline)"); };

describe("expandSkills", () => {
  const server: ServerResources = { contextFiles: [], skills: [skill("server-skill", "/server/skills/server-skill/SKILL.md", "---\nname: server-skill\n---\nSERVER_BODY")] };

  test("a server skill expands without asking the checkout; a name only the checkout has is resolved there", async () => {
    let asked = 0;
    const checkout = async () => { asked++; return [skill("repo-skill", "/repo/.agents/skills/repo-skill/SKILL.md", "REPO_BODY")]; };

    const served = text(await expandSkills([{ type: "text", text: "/server-skill go" }], server, checkout));
    expect(served).toBe(`<skill name="server-skill" location="/server/skills/server-skill/SKILL.md">
References are relative to /server/skills/server-skill.

SERVER_BODY
</skill>

/server-skill go`);
    expect(asked).toBe(0);

    const both = text(await expandSkills([{ type: "text", text: "/repo-skill and /server-skill and /nobody" }], server, checkout));
    expect(both).toStartWith(`<skill name="repo-skill" location="/repo/.agents/skills/repo-skill/SKILL.md">`);
    expect(both).toContain("REPO_BODY");
    expect(both).toContain("SERVER_BODY");
    expect(both).toEndWith("\n\n/repo-skill and /server-skill and /nobody");
    expect(asked).toBe(1);
  });

  test("content without a skill name is admitted as it is; a checkout that cannot answer fails the expansion", async () => {
    const content = [{ type: "text" as const, text: "no skills, a/path and /server-skill" }];
    expect(await expandSkills([{ type: "text", text: "no skills here" }], server, offline)).toEqual([{ type: "text", text: "no skills here" }]);
    expect(text(await expandSkills(content, server, offline))).toContain("SERVER_BODY");
    await expect(expandSkills([{ type: "text", text: "/repo-skill" }], server, offline)).rejects.toThrow("unavailable");
  });
});
