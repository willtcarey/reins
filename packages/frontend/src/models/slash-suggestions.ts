import type { InjectedSkillInfo } from "@backend/routes/skills.js";
import type { Command } from "@reins/sdk";
import { fuzzyMatch } from "../helpers/fuzzy-match.js";

/** A `/name` the composer suggests: a command, or a skill to invoke. */
export interface SlashSuggestion {
  kind: "command" | "skill";
  name: string;
  description: string;
}

/**
 * What to suggest for a `/` token whose partial name is `query`. Commands run only from the start of a
 * message (`atStart`), so only there are they suggested, first, and hide the skill of their name.
 */
export function slashSuggestions(
  query: string,
  { commands, skills, atStart }: {
    commands: readonly Command[];
    skills: readonly InjectedSkillInfo[];
    atStart: boolean;
  },
): SlashSuggestion[] {
  const shownCommands = atStart ? commands : [];
  const commandNames = new Set(shownCommands.map((command) => command.name));
  return [
    ...matching(query, shownCommands).map((command): SlashSuggestion => ({ kind: "command", name: command.name, description: command.description })),
    ...matching(query, skills.filter((skill) => !commandNames.has(skill.name))).map((skill): SlashSuggestion => ({ kind: "skill", name: skill.name, description: skill.description })),
  ];
}

/** Every item for an empty query; otherwise those whose name fuzzy-matches it, best first. */
function matching<T extends { name: string }>(query: string, items: readonly T[]): T[] {
  if (query === "") return [...items];
  const lower = query.toLowerCase();
  return items
    .map((item) => ({ item, score: fuzzyMatch(lower, item.name) }))
    .filter((scored): scored is { item: T; score: number } => scored.score !== null)
    .toSorted((a, b) => a.score - b.score)
    .map((scored) => scored.item);
}
