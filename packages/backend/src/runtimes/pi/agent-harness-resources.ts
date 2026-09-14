import { readFile } from "node:fs/promises";
import type { AgentHarnessResources } from "@earendil-works/pi-agent-core";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

/**
 * Project resources discovered by DefaultResourceLoader into AgentHarness
 * resources. Each skill file is read once per projection call; the builder
 * separately formats the model-visible listing into its supplied Reins prompt.
 */
export async function projectCodingAgentResources(
  loader: DefaultResourceLoader,
): Promise<AgentHarnessResources> {
  const skills = await Promise.all(loader.getSkills().skills.map(async (skill) => ({
    name: skill.name,
    description: skill.description,
    content: await readFile(skill.filePath, "utf8"),
    filePath: skill.filePath,
    disableModelInvocation: skill.disableModelInvocation,
  })));
  const promptTemplates = loader.getPrompts().prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    content: prompt.content,
  }));
  return { skills, promptTemplates };
}
