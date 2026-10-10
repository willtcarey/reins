import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { environmentPrompt } from "./system-prompt.js";

// Fixtures pin the node's sections as they were cut from the prompt the node used to render whole
// (before the server took over the Reins sections). `<REINS_ROOT>` is the repo root.
describe("environmentPrompt", () => {
  const root = fileURLToPath(new URL("../../../..", import.meta.url)).replace(/\/$/, "");
  const expected = (name: string) => readFileSync(new URL(`./__fixtures__/system-prompt/${name}.txt`, import.meta.url), "utf8").replaceAll("<REINS_ROOT>", root);
  const tools = [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" },
    { name: "execute", description: "Run a Reins script." }, { name: "search", description: "  Search the API.\n" }, { name: "create_task", description: "" }];

  test("lists the offered tools, this install's REINS docs, then context files and the skills the model may invoke", () => {
    const contextFiles = [{ path: "/project/AGENTS.md", content: "Follow these rules." }, { path: "/home/u/.reins/AGENTS.md", content: "Global rules.\nLine 2." }];
    const skills = [
      { name: "test-skill", description: "A test skill.", filePath: "/skills/test-skill/SKILL.md", baseDir: "/skills/test-skill", source: "project", disableModelInvocation: false },
      { name: "hidden", description: "Hidden <&>.", filePath: "/skills/hidden/SKILL.md", baseDir: "/skills/hidden", source: "user", disableModelInvocation: true },
      { name: "esc", description: "Uses <xml> & \"quotes\".", filePath: "/skills/esc/SKILL.md", baseDir: "/skills/esc", source: "user", disableModelInvocation: false },
    ];
    expect(environmentPrompt({ tools, contextFiles, skills })).toBe(expected("environment"));
  });

  test("without context files or skills, only the tools and docs", () => {
    expect(environmentPrompt({ tools: tools.slice(0, 4), contextFiles: [], skills: [] })).toBe(expected("environment-bare"));
  });

  test("names the docs in REINS_DOCS_DIR, without a developer docs line when it ships none", () => {
    // A delivered bundle's docs directory holds only features/.
    const docsDir = mkdtempSync(join(tmpdir(), "reins-docs-"));
    const previous = process.env.REINS_DOCS_DIR;
    try {
      mkdirSync(join(docsDir, "features"));
      process.env.REINS_DOCS_DIR = docsDir;

      expect(environmentPrompt({ tools: [] })).toBe(`

REINS documentation (read only when the user asks about REINS itself):
- Feature docs: ${docsDir}/features
- Skills feature doc: ${docsDir}/features/skills.md
- Skills are listed in <available_skills>; read a skill's SKILL.md only when the task matches.`);
    } finally {
      if (previous === undefined) delete process.env.REINS_DOCS_DIR;
      else process.env.REINS_DOCS_DIR = previous;
      rmSync(docsDir, { recursive: true, force: true });
    }
  });

  test("lists no tools when none is offered", () => {
    expect(environmentPrompt({ tools: [] })).not.toContain("Available tools");
  });
});
