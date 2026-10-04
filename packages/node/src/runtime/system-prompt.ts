import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatContextFilesForPrompt, formatSkillsForPrompt, type ContextFile, type Skill } from "../resources/loader.js";

const BUILTIN_TOOL_SNIPPETS: Record<string, string> = {
  read: "Read file contents",
  bash: "Execute bash commands (ls, grep, find, etc.). Already executes in the project's working directory — do not prefix commands with `cd` to the project root.",
  edit: "Make surgical edits to files (find exact text and replace)",
  write: "Create or overwrite files",
  grep: "Search file contents for patterns (respects .gitignore)",
  find: "Find files by glob pattern (respects .gitignore)",
  ls: "List directory contents",
};

interface ToolPromptShape {
  name: string;
  description?: string;
}

interface EnvironmentPromptOptions {
  /** The tools the model is offered. */
  tools: ToolPromptShape[];
  /** Context files (AGENTS.md) discovered from project + global dirs. */
  contextFiles?: readonly ContextFile[];
  /** Discovered skills to include in the prompt. */
  skills?: readonly Skill[];
}

function resolveReinsDocsPaths() {
  const currentFilePath = fileURLToPath(import.meta.url);
  const projectRoot = join(dirname(currentFilePath), "../../../..");
  return {
    devDocsPath: join(projectRoot, "docs/dev"),
    featureDocsPath: join(projectRoot, "docs/features"),
    skillsFeatureDocPath: join(projectRoot, "docs/features/skills.md"),
  };
}

function formatToolSnippet(tool: ToolPromptShape): string {
  return BUILTIN_TOOL_SNIPPETS[tool.name] ?? tool.description?.trim() ?? tool.name;
}

/**
 * The node's part of a session's system prompt, appended to the prompt the server sends when the
 * session's kind asks for it: what is local to this machine. The tools the model is offered, where this
 * install's REINS docs are, and the context files and skills of the session's checkout. Starts with a
 * blank line.
 */
export function environmentPrompt(options: EnvironmentPromptOptions): string {
  let prompt = "";
  if (options.tools.length > 0) {
    const tools = options.tools.map((tool) => `- ${tool.name}: ${formatToolSnippet(tool)}`).join("\n");
    prompt += `

Available tools:
${tools}

In addition to the tools above, you may have access to other custom tools depending on the project.`;
  }

  const { devDocsPath, featureDocsPath, skillsFeatureDocPath } = resolveReinsDocsPaths();
  prompt += `

REINS documentation (read only when the user asks about REINS itself):
- Developer workflow docs: ${devDocsPath}
- Feature docs: ${featureDocsPath}
- Skills feature doc: ${skillsFeatureDocPath}
- Skills are listed in <available_skills>; read a skill's SKILL.md only when the task matches.`;

  if (options.contextFiles && options.contextFiles.length > 0) {
    prompt += formatContextFilesForPrompt(options.contextFiles);
  }

  if (options.skills && options.skills.length > 0) {
    prompt += formatSkillsForPrompt(options.skills);
  }

  return prompt;
}
