import { describe, test, expect } from "bun:test";
import {
  applyChatEvent,
  initialChatState,
  parseLeadingSkillBlocks,
  type UserMessage,
} from "../models/chat-state.js";

describe("parseLeadingSkillBlocks", () => {
  test("returns the input untouched when there are no skill blocks", () => {
    const { visible, skills } = parseLeadingSkillBlocks("just text");
    expect(visible).toBe("just text");
    expect(skills).toEqual([]);
  });

  test("strips a single leading skill block and extracts its name", () => {
    const input = `<skill name="dip" location="/tmp/dip/SKILL.md">
body here
</skill>

/dip hello`;
    const { visible, skills } = parseLeadingSkillBlocks(input);
    expect(visible).toBe("/dip hello");
    expect(skills).toEqual([{ name: "dip", description: "" }]);
  });

  test("strips multiple leading blocks in order", () => {
    const input = `<skill name="dip" location="x">a</skill>

<skill name="tmux" location="y">b</skill>

/dip /tmux hi`;
    const { visible, skills } = parseLeadingSkillBlocks(input);
    expect(visible).toBe("/dip /tmux hi");
    expect(skills.map((s) => s.name)).toEqual(["dip", "tmux"]);
  });

  test("does not strip blocks that do not start at the beginning", () => {
    const input = `hello <skill name="dip" location="x">body</skill>`;
    const { visible, skills } = parseLeadingSkillBlocks(input);
    expect(visible).toBe(input);
    expect(skills).toEqual([]);
  });
});

describe("applyChatEvent user_message with skills", () => {
  test("attaches injectedSkills to the appended user message", () => {
    const state = initialChatState();
    const next = applyChatEvent(state, {
      type: "user_message",
      message: "/dip hi",
      skills: [{ name: "dip", description: "run dip" }],
    });
    const appended = next.messages[next.messages.length - 1] as UserMessage;
    expect(appended.role).toBe("user");
    expect(appended.injectedSkills).toEqual([{ name: "dip", description: "run dip" }]);
  });

  test("omits injectedSkills when not provided", () => {
    const state = initialChatState();
    const next = applyChatEvent(state, { type: "user_message", message: "hello" });
    const appended = next.messages[next.messages.length - 1] as UserMessage;
    expect(appended.injectedSkills).toBeUndefined();
  });
});
