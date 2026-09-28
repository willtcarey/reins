import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandLocalPrompt } from "./prompt.js";

test("skill invocation resolves on the bound node source, independently of product sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "reins-node-resources-"));
  try {
    const first = join(home, "first");
    const second = join(home, "second");
    for (const [dir, body] of [[first, "FIRST_LOCAL_BODY"], [second, "SECOND_LOCAL_BODY"]]) {
      const skillDir = join(dir, ".agents/skills/local");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `---\nname: local\ndescription: source-local skill\n---\n${body}`);
    }
    const content = [{ type: "text" as const, text: "/local run" }];
    const oneText = expandLocalPrompt(content, first).find(block => block.type === "text")?.text;
    const twoText = expandLocalPrompt(content, second).find(block => block.type === "text")?.text;
    expect(oneText).toStartWith(`<skill name="local" location="${join(first, ".agents/skills/local/SKILL.md")}">`);
    expect(oneText).toContain("FIRST_LOCAL_BODY");
    expect(oneText).not.toContain("SECOND_LOCAL_BODY");
    expect(twoText).toContain("SECOND_LOCAL_BODY");
    expect(twoText).not.toContain("FIRST_LOCAL_BODY");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
