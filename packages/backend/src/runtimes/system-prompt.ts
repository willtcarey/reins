import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContextFile, Skill } from "./resource-loader.js";
import { formatContextFilesForPrompt, formatSkillsForPrompt } from "./resource-loader.js";

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

interface TaskInfo {
  title: string;
  description: string | null;
}

interface ReinsSystemPromptOptions {
  tools: ToolPromptShape[];
  includePiDocs?: boolean;
  /** When set, includes task context (title, description) in the prompt. */
  task?: TaskInfo;
  /** When true, includes scratch session guidance (analysis-first, defer implementation to tasks). */
  isScratchSession?: boolean;
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

export function buildReinsSystemPrompt(options: ReinsSystemPromptOptions): string {
  const tools = options.tools.map((tool) => `- ${tool.name}: ${formatToolSnippet(tool)}`).join("\n");

  let prompt = `You are REINS, an agentic harness for working on projects and tasks. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${tools}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use bash for file operations like ls, rg, find
- Use read to examine files before editing. You must use this tool instead of cat or sed.
- Use edit for precise changes (old text must match exactly)
- Use write only for new files or complete rewrites
- When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did
- Be concise in your responses
- Show file paths clearly when working with files`;

  if (options.includePiDocs !== false) {
    const { devDocsPath, featureDocsPath, skillsFeatureDocPath } = resolveReinsDocsPaths();
    prompt += `

REINS documentation (read only when the user asks about REINS itself):
- Developer workflow docs: ${devDocsPath}
- Feature docs: ${featureDocsPath}
- Skills feature doc: ${skillsFeatureDocPath}
- Skills are listed in <available_skills>; read a skill's SKILL.md only when the task matches.`;
  }

  if (options.task) {
    const { title, description } = options.task;
    prompt += `\n\n## Task\nTitle: ${title}`;
    if (description) {
      prompt += `\nDescription: ${description}`;
    }
    prompt += "\n\nYou are working on this task.";
  } else if (options.isScratchSession) {
    prompt += `

This is a project assistant session — use it for discussion, analysis, planning, and small direct changes (doc updates, config tweaks, quick fixes). When the user asks you to implement a feature or make substantial code changes, create a task instead of implementing here. The task gets its own branch and session where the actual implementation happens. Do not check out task branches or write implementation code in this session.`;
  }

  if (options.contextFiles && options.contextFiles.length > 0) {
    prompt += formatContextFilesForPrompt(options.contextFiles);
  }

  if (options.skills && options.skills.length > 0) {
    prompt += formatSkillsForPrompt(options.skills);
  }

  return prompt;
}
