import type { InjectedSkillInfo } from "@backend/routes/skills.js";
import type { Command, CommandSession } from "@reins/sdk";
import { fuzzyMatch } from "./stores/quick-open-store.js";

/** A `/name` the composer suggests: a command, or a skill to invoke. */
export interface SlashSuggestion {
  kind: "command" | "skill";
  name: string;
  description: string;
  /** Why a command cannot run in the session now; null for one that can, and for skills. */
  unavailable: string | null;
}

/**
 * What to suggest for a `/` token whose partial name is `query`. Commands run only from the start of a
 * message (`atStart`), so only there are they suggested, first, and hide the skill of their name.
 */
export function slashSuggestions(
  query: string,
  { commands, skills, atStart, session }: {
    commands: readonly Command[];
    skills: readonly InjectedSkillInfo[];
    atStart: boolean;
    session: CommandSession;
  },
): SlashSuggestion[] {
  const shownCommands = atStart ? commands : [];
  const commandNames = new Set(shownCommands.map((command) => command.name));
  return [
    ...matching(query, shownCommands).map((command): SlashSuggestion => ({
      kind: "command", name: command.name, description: command.description, unavailable: command.unavailable?.(session) ?? null,
    })),
    ...matching(query, skills.filter((skill) => !commandNames.has(skill.name))).map((skill): SlashSuggestion => ({
      kind: "skill", name: skill.name, description: skill.description, unavailable: null,
    })),
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
