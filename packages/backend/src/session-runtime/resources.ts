/**
 * A session's environment resources (ADR-029, ADR-030): the server's own `~/.agents` (its AGENTS.md and
 * user skills) merged with the checkout's (the AGENTS.md files of the checkout and its ancestors, and its
 * `.agents/skills`). Both are discovered alike, over an `ExecutionEnv`: Pi's local environment for the
 * server's, the checkout's remote environment for the checkout's, whose files the server reads through
 * its node (`fs.*`). Skills are Pi's (`loadSkills`), with their content.
 */
import { posix } from "node:path";
import { homedir } from "node:os";
import { BACKGROUND_CONTEXT, loadSkills, type Context, type ExecutionEnv, type Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { NodeDocs } from "@reins/node-protocol";
import { logger } from "../logger.js";

export type { Skill };

export interface ContextFile {
  path: string;
  content: string;
}

/** The context files and skills of one place: the server's `~/.agents`, or a checkout. */
export interface Resources {
  contextFiles: ContextFile[];
  skills: Skill[];
}

/** The merged environment of one session. */
export interface SessionResources extends Resources {
  /** Where the REINS docs the node's `read` reaches are, as the node said (null: it did not). */
  docs: NodeDocs | null;
}

const CONTEXT_FILE_NAME = "AGENTS.md";

/** The server's agent config directory (`~/.agents`), resolved at each call from `HOME` (Bun's
 * `homedir()` keeps the value the process started with). */
export function serverAgentsDir(): string {
  return posix.join(process.env.HOME?.trim() || homedir(), ".agents");
}

/** The server's `~/.agents/AGENTS.md` and user skills (`~/.agents/skills`), read on this machine. */
export async function serverResources(agentDir = serverAgentsDir()): Promise<Resources> {
  const env = new NodeExecutionEnv({ cwd: agentDir });
  const [context, skills] = await Promise.all([
    contextFile(env, agentDir, BACKGROUND_CONTEXT),
    skillsIn(env, posix.join(agentDir, "skills"), BACKGROUND_CONTEXT),
  ]);
  return { contextFiles: context ? [context] : [], skills };
}

/**
 * The checkout's resources, through its environment (`env.cwd` is the checkout): the AGENTS.md files of
 * the checkout and each of its ancestors, root first, and the skills of its `.agents/skills`. A file that
 * cannot be read is left out, as one that is missing. Rejects with the signal's reason when `context`'s
 * aborts, so a discovery cut short is never taken for a complete one.
 */
export async function checkoutResources(env: ExecutionEnv, context: Context): Promise<Resources> {
  const dirs: string[] = [];
  for (let dir = env.cwd; ; dir = posix.dirname(dir)) {
    dirs.unshift(dir);
    if (posix.dirname(dir) === dir) break;
  }
  const [contextFiles, skills] = await Promise.all([
    Promise.all(dirs.map(dir => contextFile(env, dir, context))),
    skillsIn(env, posix.join(env.cwd, ".agents", "skills"), context),
  ]);
  context.abortSignal?.throwIfAborted();
  return { contextFiles: contextFiles.filter(file => file !== null), skills };
}

/** The server's resources first, then the checkout's: a skill name the server has hides the checkout's,
 * and a context file or skill file at a path already listed is listed once. */
export function mergeResources(server: Resources, checkout: Resources, docs: NodeDocs | null): SessionResources {
  const listed = new Set(server.contextFiles.map(file => file.path));
  return {
    contextFiles: [...server.contextFiles, ...checkout.contextFiles.filter(file => !listed.has(file.path))],
    skills: mergeSkills([server.skills, checkout.skills]),
    docs,
  };
}

/** Skills from several places, in order: the first skill of a name wins, and a file is listed once. */
function mergeSkills(groups: Skill[][]): Skill[] {
  const byName = new Map<string, Skill>();
  const files = new Set<string>();
  for (const skill of groups.flat()) {
    if (files.has(skill.filePath) || byName.has(skill.name)) continue;
    byName.set(skill.name, skill);
    files.add(skill.filePath);
  }
  return [...byName.values()];
}

async function contextFile(env: ExecutionEnv, dir: string, context: Context): Promise<ContextFile | null> {
  const path = posix.join(dir, CONTEXT_FILE_NAME);
  const read = await env.readTextFile(path, context);
  return read.ok ? { path, content: read.value } : null;
}

/** The skills under `dir`, as Pi discovers them: the first of a name wins. What Pi warns of (a name that
 * breaks its rules, a file it cannot read) is logged. */
async function skillsIn(env: ExecutionEnv, dir: string, context: Context): Promise<Skill[]> {
  const { skills, diagnostics } = await loadSkills(env, dir, context);
  for (const diagnostic of diagnostics) logger.debug(`Skill ${diagnostic.path}: ${diagnostic.message}`);
  return mergeSkills([skills]);
}

/**
 * Format skills into an `<available_skills>` XML block for the system prompt.
 * Skills with `disableModelInvocation` are excluded.
 */
export function formatSkillsForPrompt(skills: readonly Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];

  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

/** Format context files as a "Project Context" section for the system prompt. */
export function formatContextFilesForPrompt(contextFiles: readonly ContextFile[]): string {
  if (contextFiles.length === 0) return "";

  let section = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
  for (const { path: filePath, content } of contextFiles) {
    section += `## ${filePath}\n\n${content}\n\n`;
  }
  return section;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
