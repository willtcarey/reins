/**
 * Reins resource loader — discovers AGENTS.md context files and skills from
 * standard locations.  This is Reins' own implementation so both the pi and
 * Claude SDK runtimes can share the same discovery logic without depending
 * on pi internals.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextFile {
  path: string;
  content: string;
}

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation: boolean;
}

export interface ResourceDiagnostic {
  type: "warning" | "collision";
  message: string;
  path: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTEXT_FILE_NAME = "AGENTS.md";
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
const PROJECT_CONFIG_DIR = ".agents";
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/** Global agent config dir (`~/.agents`). */
function getDefaultAgentDir(): string {
  return join(homedir(), ".agents");
}

// ---------------------------------------------------------------------------
// ReinsResourceLoader
// ---------------------------------------------------------------------------

export class ReinsResourceLoader {
  private readonly cwd: string;
  private readonly agentDir: string;

  private _contextFiles: ContextFile[] = [];
  private _skills: Skill[] = [];
  private _diagnostics: ResourceDiagnostic[] = [];
  private _loaded = false;

  constructor(options: { cwd: string; agentDir?: string }) {
    this.cwd = options.cwd;
    this.agentDir = options.agentDir ?? getDefaultAgentDir();
  }

  /** Load (or reload) all resources from disk. */
  load(): void {
    this._contextFiles = this.discoverContextFiles();
    const { skills, diagnostics } = this.discoverSkills();
    this._skills = skills;
    this._diagnostics = diagnostics;
    this._loaded = true;
  }

  get contextFiles(): readonly ContextFile[] {
    this.ensureLoaded();
    return this._contextFiles;
  }

  get skills(): readonly Skill[] {
    this.ensureLoaded();
    return this._skills;
  }

  get diagnostics(): readonly ResourceDiagnostic[] {
    this.ensureLoaded();
    return this._diagnostics;
  }

  // -------------------------------------------------------------------------
  // Context files (AGENTS.md)
  // -------------------------------------------------------------------------

  /**
   * Discover AGENTS.md files.
   * Order: global agent dir first, then ancestor directories from root → cwd.
   */
  private discoverContextFiles(): ContextFile[] {
    const files: ContextFile[] = [];
    const seenPaths = new Set<string>();

    // Global context (e.g. ~/.agents/AGENTS.md)
    const globalContext = loadContextFileFromDir(this.agentDir);
    if (globalContext) {
      files.push(globalContext);
      seenPaths.add(globalContext.path);
    }

    // Walk from filesystem root → cwd, collecting any context files
    const ancestorFiles: ContextFile[] = [];
    let currentDir = this.cwd;
    const root = resolve("/");

    while (true) {
      const contextFile = loadContextFileFromDir(currentDir);
      if (contextFile && !seenPaths.has(contextFile.path)) {
        ancestorFiles.unshift(contextFile);
        seenPaths.add(contextFile.path);
      }
      if (currentDir === root) break;
      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }

    files.push(...ancestorFiles);
    return files;
  }

  // -------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------

  /**
   * Load skills from all standard locations.
   * Global: `~/.agents/skills/`
   * Project: `<cwd>/.agents/skills/`
   */
  private discoverSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
    const skillMap = new Map<string, Skill>();
    const realPathSet = new Set<string>();
    const allDiagnostics: ResourceDiagnostic[] = [];

    const addSkills = (result: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
      allDiagnostics.push(...result.diagnostics);
      for (const skill of result.skills) {
        let realPath: string;
        try { realPath = realpathSync(skill.filePath); } catch { realPath = skill.filePath; }

        if (realPathSet.has(realPath)) continue;

        if (skillMap.has(skill.name)) {
          allDiagnostics.push({
            type: "collision",
            message: `name "${skill.name}" collision`,
            path: skill.filePath,
          });
        } else {
          skillMap.set(skill.name, skill);
          realPathSet.add(realPath);
        }
      }
    };

    // Global skills
    addSkills(loadSkillsFromDir(join(this.agentDir, "skills"), "user", true));

    // Project skills
    addSkills(loadSkillsFromDir(resolve(this.cwd, PROJECT_CONFIG_DIR, "skills"), "project", true));

    return { skills: Array.from(skillMap.values()), diagnostics: allDiagnostics };
  }

  private ensureLoaded(): void {
    if (!this._loaded) {
      this.load();
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers (stateless — used by system-prompt.ts)
// ---------------------------------------------------------------------------

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

/**
 * Format context files as a "Project Context" section for the system prompt.
 */
export function formatContextFilesForPrompt(contextFiles: readonly ContextFile[]): string {
  if (contextFiles.length === 0) return "";

  let section = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
  for (const { path: filePath, content } of contextFiles) {
    section += `## ${filePath}\n\n${content}\n\n`;
  }
  return section;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function loadContextFileFromDir(dir: string): ContextFile | null {
  const filePath = join(dir, CONTEXT_FILE_NAME);
  if (existsSync(filePath)) {
    try {
      return { path: filePath, content: readFileSync(filePath, "utf-8") };
    } catch {
      // Unreadable file, skip
    }
  }
  return null;
}

// -- Frontmatter parser (handles the subset we need for skills) -------------

interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
}

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: normalized };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }

  const yamlBlock = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  const frontmatter: SkillFrontmatter = {};

  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key === "name") {
      frontmatter.name = value;
    } else if (key === "description") {
      frontmatter.description = value;
    } else if (key === "disable-model-invocation") {
      frontmatter["disable-model-invocation"] = value === "true";
    }
  }

  return { frontmatter, body };
}

// -- XML escaping -----------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// -- Ignore file handling ---------------------------------------------------

function loadIgnorePatterns(dir: string): string[] {
  const patterns: string[] = [];
  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, filename);
    if (!existsSync(ignorePath)) continue;
    try {
      const content = readFileSync(ignorePath, "utf-8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        patterns.push(trimmed);
      }
    } catch {
      // Ignore unreadable
    }
  }
  return patterns;
}

function shouldIgnore(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const bare = pattern.replace(/^\//, "").replace(/\/$/, "");
    if (name === bare) return true;
  }
  return false;
}

// -- Skill validation -------------------------------------------------------

function validateSkillName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];
  if (name !== parentDirName) errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
  if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters`);
  if (!/^[a-z0-9-]+$/.test(name)) errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
  if (name.startsWith("-") || name.endsWith("-")) errors.push(`name must not start or end with a hyphen`);
  if (name.includes("--")) errors.push(`name must not contain consecutive hyphens`);
  return errors;
}

function validateSkillDescription(description: string | undefined): string[] {
  if (!description || description.trim() === "") return ["description is required"];
  if (description.length > MAX_DESCRIPTION_LENGTH) return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`];
  return [];
}

function loadSkillFromFile(filePath: string, source: string): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
  const diagnostics: ResourceDiagnostic[] = [];
  try {
    const rawContent = readFileSync(filePath, "utf-8");
    const { frontmatter } = parseFrontmatter(rawContent);
    const skillDir = dirname(filePath);
    const parentDirName = basename(skillDir);

    const descErrors = validateSkillDescription(frontmatter.description);
    for (const error of descErrors) diagnostics.push({ type: "warning", message: error, path: filePath });

    const name = frontmatter.name || parentDirName;
    const nameErrors = validateSkillName(name, parentDirName);
    for (const error of nameErrors) diagnostics.push({ type: "warning", message: error, path: filePath });

    if (!frontmatter.description || frontmatter.description.trim() === "") {
      return { skill: null, diagnostics };
    }

    return {
      skill: {
        name,
        description: frontmatter.description,
        filePath,
        baseDir: skillDir,
        source,
        disableModelInvocation: frontmatter["disable-model-invocation"] === true,
      },
      diagnostics,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to parse skill file";
    diagnostics.push({ type: "warning", message, path: filePath });
    return { skill: null, diagnostics };
  }
}

function toPosixPath(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Scan a directory for skills.
 * - If a directory contains SKILL.md, treat it as a skill root (don't recurse further).
 * - Otherwise recurse into subdirectories looking for SKILL.md.
 * - At the root level, also load direct .md children.
 */
function loadSkillsFromDir(
  dir: string,
  source: string,
  includeRootFiles: boolean,
  rootDir?: string,
): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const skills: Skill[] = [];
  const diagnostics: ResourceDiagnostic[] = [];

  if (!existsSync(dir)) return { skills, diagnostics };

  const root = rootDir ?? dir;
  const ignorePatterns = loadIgnorePatterns(dir);

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    // Check if current directory IS a skill root
    for (const entry of entries) {
      if (entry.name !== "SKILL.md") continue;

      const fullPath = join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try { isFile = statSync(fullPath).isFile(); } catch { continue; }
      }

      const _relPath = toPosixPath(relative(root, fullPath));
      if (!isFile || shouldIgnore(entry.name, ignorePatterns)) continue;

      const result = loadSkillFromFile(fullPath, source);
      if (result.skill) skills.push(result.skill);
      diagnostics.push(...result.diagnostics);
      return { skills, diagnostics };
    }

    // Not a skill root — recurse into children
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
        } catch {
          continue;
        }
      }

      if (shouldIgnore(entry.name, ignorePatterns)) continue;

      if (isDirectory) {
        const subResult = loadSkillsFromDir(fullPath, source, false, root);
        skills.push(...subResult.skills);
        diagnostics.push(...subResult.diagnostics);
        continue;
      }

      // Only load .md files at the root level
      if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) continue;

      const result = loadSkillFromFile(fullPath, source);
      if (result.skill) skills.push(result.skill);
      diagnostics.push(...result.diagnostics);
    }
  } catch {
    // Unreadable directory
  }

  return { skills, diagnostics };
}
