/**
 * Prompt expansion — hoists `<skill>` blocks for each `/name` slash command
 * at the top of a user message. Runs before the runtime sees the prompt.
 *
 * Detection rule: a `/name` token is only recognized when preceded by
 * start-of-string or whitespace and followed by whitespace or end-of-string.
 * This avoids matching paths like `docker/dip` or glued tokens like `/dipfoo`.
 *
 * Deduplication: within a single message, each distinct skill is injected at
 * most once. Re-injection across turns is intentional — we don't track prior
 * invocations, so skills survive context compaction.
 *
 * The user's text is left unchanged — only the hoisted blocks are prepended.
 */

import { readFileSync } from "node:fs";
import type { Skill } from "./resource-loader.js";

export interface InjectedSkill {
  name: string;
  description: string;
  filePath: string;
}

export interface ExpandPromptResult {
  expanded: string;
  injected: InjectedSkill[];
}

/**
 * Expand any standalone `/name` slash commands in `message` that match a
 * known skill. Skill bodies are read, frontmatter stripped, and wrapped in
 * `<skill>` blocks hoisted to the top of the message.
 */
export function expandPrompt(message: string, skills: readonly Skill[]): ExpandPromptResult {
  if (!message || skills.length === 0) {
    return { expanded: message, injected: [] };
  }

  const skillsByName = new Map<string, Skill>();
  for (const skill of skills) skillsByName.set(skill.name, skill);

  const tokenRegex = /(^|\s)\/([a-z0-9-]+)(?=\s|$)/g;
  const matchedNames: string[] = [];
  const seen = new Set<string>();

  for (const match of message.matchAll(tokenRegex)) {
    const name = match[2];
    if (!skillsByName.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    matchedNames.push(name);
  }

  if (matchedNames.length === 0) {
    return { expanded: message, injected: [] };
  }

  const blocks: string[] = [];
  const injected: InjectedSkill[] = [];

  for (const name of matchedNames) {
    const skill = skillsByName.get(name);
    if (!skill) continue;

    let body: string;
    try {
      body = readSkillBody(skill);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[prompt] Failed to read skill "${name}" at ${skill.filePath}: ${detail}`);
      continue;
    }

    blocks.push(formatSkillBlock(skill, body));
    injected.push({ name: skill.name, description: skill.description, filePath: skill.filePath });
  }

  if (blocks.length === 0) {
    return { expanded: message, injected: [] };
  }

  const expanded = blocks.join("\n\n") + "\n\n" + message;
  return { expanded, injected };
}

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
