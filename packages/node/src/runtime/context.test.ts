import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiResources } from "./context.js";

test("Pi resources use Reins discovery of the source (context files and executable skills), not Pi's own, without server product state", async () => {
  // Context files reach the model only through the Reins system prompt, so Pi's loader holds none.
  const root = mkdtempSync(join(tmpdir(), "reins-pi-resources-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agents");
  const piAgentDir = join(root, "pi-agent");
  try {
    mkdirSync(join(cwd, ".agents", "skills", "project-skill"), { recursive: true });
    mkdirSync(join(agentDir, "skills", "global-skill"), { recursive: true });
    mkdirSync(join(piAgentDir, "skills", "pi-only"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "Global instructions");
    writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
    writeFileSync(join(agentDir, "skills", "global-skill", "SKILL.md"), "---\nname: global-skill\ndescription: Global skill.\n---\n\nGlobal body\n");
    writeFileSync(join(cwd, ".agents", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\ndescription: Project skill.\n---\n\nProject body\n");
    writeFileSync(join(piAgentDir, "AGENTS.md"), "Pi-only instructions");
    writeFileSync(join(piAgentDir, "skills", "pi-only", "SKILL.md"), "---\nname: pi-only\ndescription: Pi-only skill.\n---\n\nPi-only body\n");
    const { resourceLoader, resources } = await createPiResources({ cwd, reinsAgentDir: agentDir, piAgentDir });

    expect(resources.contextFiles.map((file) => file.content)).toEqual(["Global instructions", "Project instructions"]);
    expect(resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(resources.skills.map((skill) => skill.name));
    expect(resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["global-skill", "project-skill"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
