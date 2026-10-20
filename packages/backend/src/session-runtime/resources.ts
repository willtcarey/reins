/**
 * A session's environment resources (ADR-029), all from its node: the node's own
 * `~/.agents` (its AGENTS.md and user skills) merged with the checkout's (the AGENTS.md files of the
 * checkout and its ancestors, and its `.agents/skills`). Discovered over the checkout's environment, whose
 * files the server reads through its node (`fs.*`); `~` is the node's home, as Pi resolves it there.
 * Skills are Pi's (`loadSkills`), with their content.
 */
import { posix } from "node:path";
import { BACKGROUND_CONTEXT, loadSkills, withAbortSignal, type Context, type ExecutionEnv, type Skill } from "@earendil-works/pi-agent-core";
import type { NodeDocs } from "@reins/node-protocol";
import { logger } from "../logger.js";

export type { Skill };

export interface ContextFile {
  path: string;
  content: string;
}

/** The context files and skills of one place: a node's `~/.agents`, a checkout, or both merged. */
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
const AGENTS_DIR = "~/.agents";

export interface DiscoveryOptions { signal?: AbortSignal }

const contextOf = ({ signal }: DiscoveryOptions): Context => signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;

/**
 * Everything a session in the checkout (`env.cwd`) sees, through its node: the node's `~/.agents`, then
 * the checkout's (`mergeResources`). Rejects as `checkoutResources` does.
 */
export async function nodeResources(env: ExecutionEnv, options: DiscoveryOptions = {}): Promise<Resources> {
  const context = contextOf(options);
  const [agents, checkout] = await Promise.all([agentsResources(env, context), checkoutContents(env, context)]);
  return mergeResources(agents, checkout);
}

/** The node's `~/.agents/AGENTS.md` and user skills (`~/.agents/skills`). */
async function agentsResources(env: ExecutionEnv, context: Context): Promise<Resources> {
  const dir = await env.absolutePath(AGENTS_DIR, context);
  if (!dir.ok) return { contextFiles: [], skills: [] };
  const [file, skills] = await Promise.all([
    contextFile(env, dir.value, context),
    skillsIn(env, posix.join(dir.value, "skills"), context),
  ]);
  return { contextFiles: file ? [file] : [], skills };
}

/**
 * The checkout's resources, through its environment (`env.cwd` is the checkout): the AGENTS.md files of
 * the checkout and each of its ancestors, root first, and the skills of its `.agents/skills`. A file that
 * cannot be read is left out, as one that is missing. Rejects with the signal's reason when `signal`
 * aborts, so a discovery cut short is never taken for a complete one.
 */
export function checkoutResources(env: ExecutionEnv, options: DiscoveryOptions = {}): Promise<Resources> {
  return checkoutContents(env, contextOf(options));
}

async function checkoutContents(env: ExecutionEnv, context: Context): Promise<Resources> {
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

/** `~/.agents` first, then the checkout's: a skill name `~/.agents` has hides the checkout's, and a
 * context file or skill file at a path already listed is listed once. */
function mergeResources(agents: Resources, checkout: Resources): Resources {
  const listed = new Set(agents.contextFiles.map(file => file.path));
  return {
    contextFiles: [...agents.contextFiles, ...checkout.contextFiles.filter(file => !listed.has(file.path))],
    skills: mergeSkills([agents.skills, checkout.skills]),
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
