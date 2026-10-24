import { describe, expect, test } from "bun:test";
import type { Command } from "@reins/sdk";
import { slashSuggestions } from "../../models/slash-suggestions.js";

const commands: Command[] = [
  { name: "compact", description: "Summarize the conversation", unavailable: ({ running }) => (running ? "The session is running" : null), run: () => {} },
  { name: "new", description: "Start a new session", run: () => {} },
];
const skills = [
  { name: "dip", description: "Docker commands" },
  { name: "new", description: "A skill named like a command" },
];
const idle = { sessionId: "s1", running: false };

describe("slashSuggestions", () => {
  test("suggests commands before skills at the start of a message, a command hiding the skill of its name", () => {
    expect(slashSuggestions("", { commands, skills, atStart: true, session: idle })).toEqual([
      { kind: "command", name: "compact", description: "Summarize the conversation", unavailable: null },
      { kind: "command", name: "new", description: "Start a new session", unavailable: null },
      { kind: "skill", name: "dip", description: "Docker commands", unavailable: null },
    ]);
  });

  test("suggests only skills after the start of a message, where commands do not run", () => {
    expect(slashSuggestions("n", { commands, skills, atStart: false, session: idle })).toEqual([
      { kind: "skill", name: "new", description: "A skill named like a command", unavailable: null },
    ]);
  });

  test("says why a command cannot run in the session now", () => {
    const [compact] = slashSuggestions("comp", { commands, skills, atStart: true, session: { sessionId: "s1", running: true } });

    expect(compact).toEqual({ kind: "command", name: "compact", description: "Summarize the conversation", unavailable: "The session is running" });
  });
});
