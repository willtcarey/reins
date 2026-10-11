/**
 * A session's environment resources (ADR-029): the server's own `~/.agents` (its AGENTS.md and user
 * skills, read on this machine) merged with what the checkout has, which its node reports with content
 * (`checkout.environment`: the AGENTS.md files of the checkout and its ancestors, and its `.agents/skills`).
 * The server's skills are discovered as the node discovers the checkout's (`checkout-environment.ts` in
 * the node package).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import type { CheckoutEnvironmentResult } from "@reins/node-protocol";

export interface ContextFile {
  path: string;
  content: string;
}

/** A skill the session may invoke: the server's (read here when expanded) or the checkout's (with its
 * content, from the node). */
export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  /** The SKILL.md's content, for a checkout's skill; a server skill is read when expanded. */
  content?: string;
}

/** The server's resources, from its own `~/.agents`. */
export interface ServerResources {
  contextFiles: ContextFile[];
  skills: Skill[];
}

/** The merged environment of one session. */
export interface SessionResources extends ServerResources {
  /** Where the REINS docs the node's `read` reaches are. */
  docs: CheckoutEnvironmentResult["docs"];
}

const CONTEXT_FILE_NAME = "AGENTS.md";
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** The server's agent config directory (`~/.agents`), resolved at each call from `HOME` (Bun's
 * `homedir()` keeps the value the process started with). */
export function serverAgentsDir(): string {
  return join(process.env.HOME?.trim() || homedir(), ".agents");
}

/** The server's `~/.agents/AGENTS.md` and user skills (`~/.agents/skills`). */
export function serverResources(agentDir = serverAgentsDir()): ServerResources {
  const context = loadContextFile(agentDir);
  return { contextFiles: context ? [context] : [], skills: mergeSkills([loadSkillsFromDir(join(agentDir, "skills"), true)]) };
}

/** The server's resources first, then the checkout's: a skill name the server has hides the checkout's,
 * and a context file at a path already listed is listed once. */
export function mergeResources(server: ServerResources, checkout: CheckoutEnvironmentResult): SessionResources {
  const listed = new Set(server.contextFiles.map(file => file.path));
  return {
    contextFiles: [...server.contextFiles, ...checkout.contextFiles.filter(file => !listed.has(file.path))],
    skills: mergeSkills([server.skills, checkout.skills.map(skill => ({
      name: skill.name, description: skill.description, filePath: skill.path, baseDir: posix.dirname(skill.path),
      disableModelInvocation: skill.disableModelInvocation, content: skill.content,
    }))]),
    docs: checkout.docs,
  };
}

/** A skill's SKILL.md content: the checkout's as the node sent it, a server skill's read now (null when
 * it disappeared after discovery). */
export function skillContent(skill: Skill): string | null {
  if (skill.content !== undefined) return skill.content;
  try { return readFileSync(skill.filePath, "utf8"); } catch { return null; }
}

/** Skills from several locations, in order: the first skill of a name wins, and a file reached twice
 * (through a symlink) counts once. */
function mergeSkills(groups: Skill[][]): Skill[] {
  const byName = new Map<string, Skill>();
  const files = new Set<string>();
  for (const skill of groups.flat()) {
    let realPath = skill.filePath;
    if (skill.content === undefined) { try { realPath = realpathSync(skill.filePath); } catch { /* listed as found */ } }
    if (files.has(realPath) || byName.has(skill.name)) continue;
    byName.set(skill.name, skill);
    files.add(realPath);
  }
  return [...byName.values()];
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

function loadContextFile(dir: string): ContextFile | null {
  const filePath = join(dir, CONTEXT_FILE_NAME);
  if (!existsSync(filePath)) return null;
  try { return { path: filePath, content: readFileSync(filePath, "utf-8") }; } catch { return null; }
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
}

function parseFrontmatter(content: string): SkillFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return {};
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return {};

  const frontmatter: SkillFrontmatter = {};
  for (const line of normalized.slice(4, endIndex).split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key === "name") frontmatter.name = value;
    else if (key === "description") frontmatter.description = value;
    else if (key === "disable-model-invocation") frontmatter["disable-model-invocation"] = value === "true";
  }
  return frontmatter;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function loadIgnorePatterns(dir: string): string[] {
  const patterns: string[] = [];
  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, filename);
    if (!existsSync(ignorePath)) continue;
    try {
      for (const line of readFileSync(ignorePath, "utf-8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) patterns.push(trimmed);
      }
    } catch { /* unreadable */ }
  }
  return patterns;
}

function shouldIgnore(name: string, patterns: string[]): boolean {
  return patterns.some(pattern => name === pattern.replace(/^\//, "").replace(/\/$/, ""));
}

/** A skill file, or null when it has no description (a skill without one is not listed). A name or
 * description that breaks the naming rules is still loaded, as the node's discovery does (it only warns). */
function loadSkillFromFile(filePath: string): Skill | null {
  try {
    const frontmatter = parseFrontmatter(readFileSync(filePath, "utf-8"));
    const skillDir = dirname(filePath);
    const description = frontmatter.description;
    if (!description || description.trim() === "") return null;
    return { name: frontmatter.name || basename(skillDir), description, filePath, baseDir: skillDir, disableModelInvocation: frontmatter["disable-model-invocation"] === true };
  } catch {
    return null;
  }
}

/**
 * Scan a directory for skills.
 * - If a directory contains SKILL.md, treat it as a skill root (don't recurse further).
 * - Otherwise recurse into subdirectories looking for SKILL.md.
 * - At the root level, also load direct .md children.
 */
function loadSkillsFromDir(dir: string, includeRootFiles: boolean): Skill[] {
  const skills: Skill[] = [];
  if (!existsSync(dir)) return skills;
  const ignorePatterns = loadIgnorePatterns(dir);
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name !== "SKILL.md") continue;
      const fullPath = join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try { isFile = statSync(fullPath).isFile(); } catch { continue; }
      }
      if (!isFile || shouldIgnore(entry.name, ignorePatterns)) continue;
      const skill = loadSkillFromFile(fullPath);
      return skill ? [skill] : [];
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch { continue; }
      }
      if (shouldIgnore(entry.name, ignorePatterns)) continue;
      if (isDirectory) { skills.push(...loadSkillsFromDir(fullPath, false)); continue; }
      if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) continue;
      const skill = loadSkillFromFile(fullPath);
      if (skill) skills.push(skill);
    }
  } catch { /* unreadable directory */ }
  return skills;
}
