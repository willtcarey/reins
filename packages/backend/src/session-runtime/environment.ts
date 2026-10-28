/**
 * A session's environment on the server (ADR-029): its checkout prepared on its node (the task
 * branch checked out through the server's `Git` over `process.run`), the environment section of its
 * system prompt (the tools, the node's REINS docs, the context files and skills from its node), and slash
 * expansion of the same skills.
 */
import { posix } from "node:path";
import { formatSkillInvocation } from "@earendil-works/pi-agent-core";
import type { PromptBlock } from "./events.js";
import { Git } from "../git.js";
import type { NodeDirClient } from "../nodes/node-dir-client.js";
import type { NodeClient } from "../state.js";
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
- Skills are listed in <available_skills>; read a skill's SKILL.md only when the task matches.`;
  }

  prompt += formatContextFilesForPrompt(resources.contextFiles);
  prompt += formatSkillsForPrompt(resources.skills);
  return prompt;
}

/**
 * Expands slash invocations of skills (`/name`) into the prompt's first text block. `skills` (which needs
 * the session's node) is asked only when the content has a `/name` token, and its failure (the node
 * offline) fails the expansion. Names no skill has are left as they are.
 */
export async function expandSkills(content: PromptBlock[], skills: () => Promise<Skill[]>): Promise<PromptBlock[]> {
  const tokens = content.flatMap(block => block.type === "text"
    ? [...block.text.matchAll(/(^|\s)\/([a-z0-9-]+)(?=\s|$)/g)].map(match => match[2]!)
    : []);
  if (!tokens.length) return content;

  const byName = new Map((await skills()).map(skill => [skill.name, skill]));
  const blocks: string[] = [];
  for (const name of tokens) {
    const skill = byName.get(name);
    if (skill) blocks.push(formatSkillInvocation(skill));
  }
  if (!blocks.length) return content;
  const firstTextIndex = content.findIndex(block => block.type === "text");
  return content.map((block, index) => index === firstTextIndex && block.type === "text"
    ? { ...block, text: `${blocks.join("\n\n")}\n\n${block.text}` }
    : block);
}

/** The checkout could not be prepared, definitively (not because its node is unreachable): a git
 * failure, a missing checkout, a removed node. */
export class CheckoutPreparationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Preparing the checkout failed: ${message}`, options);
    this.name = "CheckoutPreparationError";
  }
}

/** Checks out `branch` (none for a scratch session) unless it is checked out: from the start again when the
 * node's link drops midway, as it is safe to repeat. */
export async function prepareCheckout(checkout: NodeDirClient, branch: string | null, signal: AbortSignal): Promise<NodeClient> {
  try {
    return await checkout.repeat(async () => {
      const node = await checkout.connectedNode({ signal });
      if (branch) {
        const git = new Git(checkout.spawner({ signal }));
        if (await git.getCurrentBranch() !== branch) await git.checkoutBranch(branch);
      }
      return node;
    }, { signal });
  } catch (error) {
    signal.throwIfAborted();
    throw new CheckoutPreparationError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}
