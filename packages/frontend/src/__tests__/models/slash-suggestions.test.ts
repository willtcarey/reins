import { describe, expect, test } from "bun:test";
import type { Command } from "@reins/sdk";
import { slashSuggestions } from "../../models/slash-suggestions.js";

const commands: Command[] = [
  { name: "compact", description: "Summarize the conversation", run: () => {} },
  { name: "new", description: "Start a new session", run: () => {} },
];
const skills = [
  { name: "dip", description: "Docker commands" },
  { name: "new", description: "A skill named like a command" },
];

describe("slashSuggestions", () => {
  test("suggests commands before skills at the start of a message, a command hiding the skill of its name", () => {
    expect(slashSuggestions("", { commands, skills, atStart: true })).toEqual([
      { kind: "command", name: "compact", description: "Summarize the conversation" },
      { kind: "command", name: "new", description: "Start a new session" },
      { kind: "skill", name: "dip", description: "Docker commands" },
    ]);
  });

  test("suggests only skills after the start of a message, where commands do not run", () => {
    expect(slashSuggestions("n", { commands, skills, atStart: false })).toEqual([
      { kind: "skill", name: "new", description: "A skill named like a command" },
    ]);
  });
});
