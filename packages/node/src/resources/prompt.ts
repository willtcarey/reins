import { readFileSync } from "node:fs";
import { ReinsResourceLoader, type Skill } from "./loader.js";

export type LocalPromptBlock = { type: "text"; text: string } | {
  type: "image"; attachmentId: string; mimeType: string;
  filename?: string; byteSize: number; sha256?: string; width?: number; height?: number;
};

/** Expand a slash invocation on the source host, not from server project.path. */
export function expandLocalPrompt(content: LocalPromptBlock[], cwd: string): LocalPromptBlock[] {
  const tokens = content.flatMap(block => block.type === "text"
    ? [...block.text.matchAll(/(^|\s)\/([a-z0-9-]+)(?=\s|$)/g)].map(match => match[2]!)
    : []);
  if (!tokens.length) return content;

  const loader = new ReinsResourceLoader({ cwd });
  loader.load();
  const byName = new Map(loader.skills.map(skill => [skill.name, skill]));
  const blocks: string[] = [];
  for (const name of tokens) {
    const skill = byName.get(name);
    if (!skill) continue;
    let body: string;
    try {
      body = stripFrontmatter(readFileSync(skill.filePath, "utf8"));
    } catch {
      // A skill file that disappeared after discovery is skipped.
      continue;
    }
    blocks.push(formatSkillBlock(skill, body));
  }
  if (!blocks.length) return content;
  const firstTextIndex = content.findIndex(block => block.type === "text");
  return content.map((block, index) => index === firstTextIndex && block.type === "text"
    ? { ...block, text: `${blocks.join("\n\n")}\n\n${block.text}` }
    : block);
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return normalized;
  const endIndex = normalized.indexOf("\n---", 3);
  return endIndex === -1 ? normalized : normalized.slice(endIndex + 4).trim();
}

function formatSkillBlock(skill: Skill, body: string): string {
  return `<skill name="${skill.name}" location="${skill.filePath}">
References are relative to ${skill.baseDir}.

${body}
</skill>`;
}
