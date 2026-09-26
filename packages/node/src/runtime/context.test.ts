import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiResources } from "./context.js";

test("Pi resource context discovers the node source without server product state", async () => {
  const home = mkdtempSync(join(tmpdir(), "reins-pi-context-"));
  try {
    const cwd = join(home, "source");
    mkdirSync(join(cwd, ".agents/skills/local"), { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "NODE_CONTEXT");
    writeFileSync(join(cwd, ".agents/skills/local/SKILL.md"), "---\nname: local\ndescription: local resource\n---\nNODE_SKILL");
    const context = await createPiResources({ cwd, reinsAgentDir: join(home, "empty"), piAgentDir: join(home, "pi") });
    expect(context.resources.contextFiles.find(file => file.path === join(cwd, "AGENTS.md"))?.content).toBe("NODE_CONTEXT");
    expect(context.resourceLoader.getSkills().skills.map(skill => skill.name)).toEqual(["local"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
