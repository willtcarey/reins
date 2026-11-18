/**
 * A session's environment on the server (ADR-029): where its task started, read through the server's `Git` over
 * `process.start`, the environment section of its system prompt (the tools, the
 * node's REINS docs, the context files and skills from its node), and slash expansion of the same skills.
 */
import { posix } from "node:path";
import { formatSkillInvocation } from "@taco-ai/pi-harness";
import type { PromptBlock } from "./events.js";
import { Git } from "../git.js";
import type { NodeDirClient } from "../nodes/node-dir-client.js";
import { formatContextFilesForPrompt, formatSkillsForPrompt, type SessionResources, type Skill } from "./resources.js";

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

function formatToolSnippet(tool: ToolPromptShape): string {
  return BUILTIN_TOOL_SNIPPETS[tool.name] ?? tool.description?.trim() ?? tool.name;
}

/**
 * The environment part of a session's system prompt, appended to its kind's prompt when the kind asks
 * for it: the session's working directory on its node, the tools the model is offered, where the REINS
 * docs are on the node (the model reads them with `read`, which runs there), and the merged context files
 * and skills. Starts with a blank line.
 */
export function environmentPrompt({ cwd, tools, resources }: { cwd: string; tools: ToolPromptShape[]; resources: SessionResources }): string {
  // Pi's own prompt has this exact line, and proxies such as Meridian read the client's directory from it.
  // It comes before the context files, so a line of theirs cannot be read in its place.
  let prompt = `

Current working directory: ${cwd}`;
  if (tools.length > 0) {
    prompt += `

Available tools:
${tools.map((tool) => `- ${tool.name}: ${formatToolSnippet(tool)}`).join("\n")}

In addition to the tools above, you may have access to other custom tools depending on the project.`;
  }

  if (resources.docs) {
    const { dir, devDocs } = resources.docs;
    prompt += `

REINS documentation (read only when the user asks about REINS itself):${devDocs ? `
- Developer workflow docs: ${posix.join(dir, "dev")}` : ""}
- Feature docs: ${posix.join(dir, "features")}
- Skills feature doc: ${posix.join(dir, "features/skills.md")}
- Building extensions (extensions load from a directory; read before writing one): ${posix.join(dir, "features/building-extensions.md")}
- Skills are listed in <available_skills>; read a skill's SKILL.md only when the task matches.`;
  }

  prompt += formatContextFilesForPrompt(resources.contextFiles);
  prompt += formatSkillsForPrompt(resources.skills);
  return prompt;
}

/** A prompt with its metadata, as a session admits it. */
export interface ExpandedPrompt { content: PromptBlock[]; metadata: Record<string, unknown> }

/**
 * Expands slash invocations of skills (`/name`): the message stays as typed, and each skill's text follows it as a
 * hidden block (the chat folds it under the message, labelled with the skills' names; the model gets it after the
 * message's text). A message that has hidden blocks already gets the skills after them, under its own label.
 * `skills` (which needs the session's node) is asked only when the content has a `/name` token, and its failure
 * (the node offline) fails the expansion. Names no skill has are left as they are.
 */
export async function expandSkills(content: PromptBlock[], metadata: Record<string, unknown>, skills: () => Promise<Skill[]>): Promise<ExpandedPrompt> {
  const tokens = content.flatMap(block => block.type === "text"
    ? [...block.text.matchAll(/(^|\s)\/([a-z0-9-]+)(?=\s|$)/g)].map(match => match[2]!)
    : []);
  if (!tokens.length) return { content, metadata };

  const byName = new Map((await skills()).map(skill => [skill.name, skill]));
  const used = [...new Set(tokens)].flatMap(name => byName.get(name) ?? []);
  if (!used.length) return { content, metadata };
  const hidden = used.map(skill => ({ type: "text" as const, text: formatSkillInvocation(skill) }));
  if (hasDetails(metadata)) return { content: [...content, ...hidden], metadata };
  const label = `${used.length === 1 ? "Skill" : "Skills"} ${used.map(skill => `/${skill.name}`).join(", ")}`;
  return { content: [...content, ...hidden], metadata: { ...metadata, details: { start: content.length, label: label.slice(0, 80) } } };
}

const hasDetails = (metadata: Record<string, unknown>) => typeof metadata.details === "object" && metadata.details !== null;

/** Where a task started: the branch its checkout is on (`HEAD` when detached) and its commit; null when git
 * cannot tell (not a repository, no commit yet), which leaves the task without it for now. */
export async function readCheckoutStart(checkout: NodeDirClient, signal: AbortSignal): Promise<{ branch: string; commit: string } | null> {
  const git = new Git(checkout.spawner({ signal }));
  try {
    const [branch, commit] = await Promise.all([git.getCurrentBranch(), git.revParse("HEAD")]);
    return commit ? { branch, commit } : null;
  } catch {
    signal.throwIfAborted();
    return null;
  }
}
