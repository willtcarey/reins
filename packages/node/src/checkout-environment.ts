/**
 * What of a session's environment a checkout has (`checkout.environment`, served by the tool host,
 * host-env.ts): the AGENTS.md files of the checkout and its ancestors, the checkout's skills
 * (`.agents/skills`), and where this install's REINS docs are. Never the node's own `~/.agents`: the
 * server supplies its own (ADR-029).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ContextFile {
  path: string;
  content: string;
}

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
}

const CONTEXT_FILE_NAME = "AGENTS.md";
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
const PROJECT_CONFIG_DIR = ".agents";

/** This install's docs: `REINS_DOCS_DIR` (a delivered bundle's, which ships only `features/`), else the
 * checkout's `docs/`; and whether they include the developer docs (`dev/`). */
export function reinsDocs(): { dir: string; devDocs: boolean } {
  const dir = process.env.REINS_DOCS_DIR || join(dirname(fileURLToPath(import.meta.url)), "../../../docs");
  return { dir, devDocs: existsSync(join(dir, "dev")) };
}

/** The AGENTS.md files in `cwd` and its ancestors, from the filesystem root to `cwd`. */
export function checkoutContextFiles(cwd: string): ContextFile[] {
  const files: ContextFile[] = [];
  let currentDir = cwd;
  const root = resolve("/");
  while (true) {
    const contextFile = loadContextFileFromDir(currentDir);
    if (contextFile) files.unshift(contextFile);
    if (currentDir === root) break;
    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return files;
}

/** The skills of the checkout at `cwd` (`.agents/skills`): the first skill of a name wins, and a file
 * reached twice (through a symlink) counts once. A skill without a description is not listed. */
export function checkoutSkills(cwd: string): Skill[] {
  const byName = new Map<string, Skill>();
  const realPaths = new Set<string>();
  for (const skill of loadSkillsFromDir(resolve(cwd, PROJECT_CONFIG_DIR, "skills"), true)) {
    let realPath: string;
    try { realPath = realpathSync(skill.filePath); } catch { realPath = skill.filePath; }
    if (realPaths.has(realPath) || byName.has(skill.name)) continue;
    byName.set(skill.name, skill);
    realPaths.add(realPath);
  }
  return [...byName.values()];
}

function loadContextFileFromDir(dir: string): ContextFile | null {
  const filePath = join(dir, CONTEXT_FILE_NAME);
  if (!existsSync(filePath)) return null;
  try { return { path: filePath, content: readFileSync(filePath, "utf-8") }; } catch { return null; }
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
}

/** The frontmatter fields a skill uses (the subset of YAML they are written in). */
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

/** A skill file, or null when it has no description. A name that breaks the naming rules is still
 * loaded; without one, the skill is named for its directory. */
function loadSkillFromFile(filePath: string): Skill | null {
  try {
    const frontmatter = parseFrontmatter(readFileSync(filePath, "utf-8"));
    const description = frontmatter.description;
    if (!description || description.trim() === "") return null;
    return { name: frontmatter.name || basename(dirname(filePath)), description, filePath, disableModelInvocation: frontmatter["disable-model-invocation"] === true };
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
