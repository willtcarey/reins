import type { InjectedSkillInfo } from "@backend/routes/skills.js";
import type { Command } from "@reins/sdk";
import { fuzzyMatch } from "../helpers/fuzzy-match.js";
import { commandAvailable } from "../sdk-host/commands.js";

/** A `/name` the composer suggests: a command, or a skill to invoke. */
export interface SlashSuggestion {
  kind: "command" | "skill";
  name: string;
  description: string;
}

/**
 * What to suggest for a `/` token whose partial name is `query`. Commands run only from the start of a
 * message (`atStart`), so only there are they suggested, first, and hide the skill of their name; one that does
 * not apply here (`Command.available`) is not suggested, but still hides the skill, as it still wins when typed.
 */
export function slashSuggestions(
  query: string,
  { commands, skills, atStart }: {
    commands: readonly Command[];
    skills: readonly InjectedSkillInfo[];
    atStart: boolean;
  },
): SlashSuggestion[] {
  const shownCommands = atStart ? commands.filter(commandAvailable) : [];
  const commandNames = new Set((atStart ? commands : []).map((command) => command.name));
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
