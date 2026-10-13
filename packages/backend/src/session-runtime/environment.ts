/**
 * A session's environment on the server (ADR-029, ADR-030): its checkout prepared on its node (the task
 * branch checked out through the server's `Git` over `process.run`), the environment section of its
 * system prompt (the tools, the node's REINS docs, the merged context files and skills), and slash
 * expansion of skills with the same merge.
 */
import { posix } from "node:path";
import { formatSkillInvocation } from "@earendil-works/pi-agent-core";
import { RpcFailure } from "@reins/node-protocol";
import type { PromptBlock } from "./events.js";
import { Git } from "../git.js";
import { nodeSpawn } from "../spawn.js";
import type { RemoteNode } from "../state.js";
import { formatContextFilesForPrompt, formatSkillsForPrompt, type Resources, type SessionResources, type Skill } from "./resources.js";

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
 * for it: the tools the model is offered, where the REINS docs are on the session's node (the model reads
 * them with `read`, which runs there), and the merged context files and skills. Starts with a blank line.
 */
export function environmentPrompt({ tools, resources }: { tools: ToolPromptShape[]; resources: SessionResources }): string {
  let prompt = "";
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
 * Expands slash invocations of skills (`/name`) into the prompt's first text block. The server's skills
 * come first; `checkoutSkills` (the merged skills, which needs the session's node) is asked only for a
 * name the server has no skill of, and its failure (the node offline) fails the expansion. Names no skill
 * has are left as they are.
 */
export async function expandSkills(content: PromptBlock[], server: Resources, checkoutSkills: () => Promise<Skill[]>): Promise<PromptBlock[]> {
  const tokens = content.flatMap(block => block.type === "text"
    ? [...block.text.matchAll(/(^|\s)\/([a-z0-9-]+)(?=\s|$)/g)].map(match => match[2]!)
    : []);
  if (!tokens.length) return content;

  const byName = new Map(server.skills.map(skill => [skill.name, skill]));
  if (tokens.some(name => !byName.has(name))) {
    for (const skill of await checkoutSkills()) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
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

/** Where a session's checkout is: its source on its node, and the branch to check out there (none for a
 * scratch session). */
export interface CheckoutTarget { nodeId: string; cwd: string; branch: string | null }

const NODE_WAIT_BACKOFF_MS = { initial: 100, max: 2_000 };

/** The checkout could not be prepared, definitively (not because its node is unreachable): a git
 * failure, a missing checkout, a removed node. */
export class CheckoutPreparationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Preparing the checkout failed: ${message}`, options);
    this.name = "CheckoutPreparationError";
  }
}

/** The node is not connected, or no app is current to reach it through (a reload's gap). */
const unreachable = (error: unknown) => error instanceof RpcFailure && error.code === "unavailable";

/**
 * Prepares a session's checkout for a run: checks out its branch on its node when another is checked out.
 * Waits for the node meanwhile, however long, calling `waiting(true)` while it waits and `waiting(false)`
 * while it works, and resolves with the node it prepared it on. Rejects with the signal's reason when
 * `signal` aborts, and with `CheckoutPreparationError` on a definitive failure.
 */
export async function prepareCheckout(nodeFor: (signal: AbortSignal) => Promise<RemoteNode>, { cwd, branch }: CheckoutTarget, { signal, waiting }: { signal: AbortSignal; waiting: (waiting: boolean) => void }): Promise<RemoteNode> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const node = await nodeFor(signal);
      if (!node.connected) throw new RpcFailure("unavailable", `Node ${node.id} is not connected`);
      waiting(false);
      if (branch) {
        const git = new Git(nodeSpawn(node, cwd));
        if (await git.getCurrentBranch() !== branch) await git.checkoutBranch(branch);
      }
      return node;
    } catch (error) {
      signal.throwIfAborted();
      if (!unreachable(error)) throw new CheckoutPreparationError(error instanceof Error ? error.message : String(error), { cause: error });
      waiting(true);
      await sleep(Math.min(NODE_WAIT_BACKOFF_MS.max, NODE_WAIT_BACKOFF_MS.initial * 2 ** attempt), signal);
    }
  }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
});
