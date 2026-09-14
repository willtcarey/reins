import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { projectCodingAgentResources } from "../../../runtimes/pi/agent-harness-resources.js";

describe("AgentHarness coding-agent resource projection", () => {
  test("projects discovered skill content once per call", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-harness-resources-"));
    const skillDir = join(root, "skills", "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nUnique skill instructions.");
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      systemPrompt: "coding-agent default",
      additionalSkillPaths: [skillDir],
      skillsOverride: (base) => ({ ...base, skills: base.skills.filter((skill) => skill.name === "review") }),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const resources = await projectCodingAgentResources(loader);

    expect(resources.skills).toEqual([{
      name: "review",
      description: "Review code",
      content: "---\nname: review\ndescription: Review code\n---\nUnique skill instructions.",
      filePath: join(skillDir, "SKILL.md"),
      disableModelInvocation: false,
    }]);
    expect(JSON.stringify(resources).match(/Unique skill instructions\./g)).toHaveLength(1);
  });
});
