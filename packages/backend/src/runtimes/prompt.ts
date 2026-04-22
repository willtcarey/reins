/**
 * Prompt expansion — hoists `<skill>` blocks for each `/name` slash command
 * at the top of a user message. Runs before the runtime sees the prompt.
 *
 * Detection rule: a `/name` token is only recognized when preceded by
 * start-of-string or whitespace and followed by whitespace or end-of-string.
 * This avoids matching paths like `docker/dip` or glued tokens like `/dipfoo`.
 *
 * The user's text is left unchanged — only the hoisted blocks are prepended.
 */

import { readFileSync } from "node:fs";
import { getProject } from "../project-store.js";
import { getSession } from "../session-store.js";
import { ReinsResourceLoader, type Skill } from "./resource-loader.js";

export interface InjectedSkill {
  name: string;
  description: string;
  filePath: string;
}

export interface ExpandPromptResult {
  expanded: string;
  injected: InjectedSkill[];
}

/** Matches standalone `/name` tokens (same detection rule as docs). */
const SLASH_TOKEN_REGEX = /(^|\s)\/([a-z0-9-]+)(?=\s|$)/g;

/**
 * Extract all standalone `/name` tokens from a message, in order of
 * appearance. Duplicates are preserved — callers control dedup policy.
 */
function extractSlashTokens(message: string): string[] {
  if (!message) return [];
  const names: string[] = [];
  for (const match of message.matchAll(SLASH_TOKEN_REGEX)) names.push(match[2]);
  return names;
}

/**
 * Expand any standalone `/name` slash commands in `message` that match a
 * skill available to the given session's project. Thin wrapper that only
 * resolves the session's projectDir and delegates — all skill-detection and
 * loader work happens in `expandPromptWithSkills`.
 */
export function expandPrompt(message: string, sessionId: string): ExpandPromptResult {
  const row = getSession(sessionId);
  if (!row) return { expanded: message, injected: [] };

  const project = getProject(row.project_id);
  if (!project) return { expanded: message, injected: [] };

  return expandPromptWithSkills(message, { cwd: project.path });
}

/**
 * Decide whether the message contains any `/name` tokens, and only then
 * instantiate a resource loader to resolve them against available skills.
 *
 * Accepts `ReinsResourceLoader` constructor options directly so tests can
 * pin `agentDir` to a known location (isolating from the user's real
 * `~/.agents/skills`).
 */
export function expandPromptWithSkills(
  message: string,
  loaderOptions: { cwd: string; agentDir?: string },
): ExpandPromptResult {
  const candidates = extractSlashTokens(message);
  if (candidates.length === 0) return { expanded: message, injected: [] };

  const loader = new ReinsResourceLoader(loaderOptions);
  loader.load();

  const byName = new Map<string, Skill>();
  for (const skill of loader.skills) byName.set(skill.name, skill);

  const matched: Skill[] = [];
  for (const name of candidates) {
    const skill = byName.get(name);
    if (skill) matched.push(skill);
  }

  if (matched.length === 0) return { expanded: message, injected: [] };

  const blocks: string[] = [];
  const injected: InjectedSkill[] = [];

  for (const skill of matched) {
    let body: string;
    try {
      body = readSkillBody(skill);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[prompt] Failed to read skill "${skill.name}" at ${skill.filePath}: ${detail}`);
      continue;
    }

    blocks.push(formatSkillBlock(skill, body));
    injected.push({ name: skill.name, description: skill.description, filePath: skill.filePath });
  }

  if (blocks.length === 0) return { expanded: message, injected: [] };

  return { expanded: blocks.join("\n\n") + "\n\n" + message, injected };
}

// Re-export for backward compatibility — canonical home is models/skill.ts
export { stripLeadingSkillBlocks } from "../models/skill.js";

/**
 * Read a skill's SKILL.md body with YAML frontmatter stripped.
 */
export function readSkillBody(skill: Skill): string {
  const raw = readFileSync(skill.filePath, "utf-8");
  return stripFrontmatter(raw);
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return normalized;

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return normalized;

  return normalized.slice(endIndex + 4).trim();
}

function formatSkillBlock(skill: Skill, body: string): string {
  return `<skill name="${skill.name}" location="${skill.filePath}">
References are relative to ${skill.baseDir}.

${body}
</skill>`;
}
