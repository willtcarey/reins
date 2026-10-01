import { expect, test } from "bun:test";
import { stripLeadingSkillBlocks } from "../../models/skill.js";

test("strips leading skill blocks but retains the user's prompt", () => {
  expect(stripLeadingSkillBlocks(null)).toBeNull();
  expect(stripLeadingSkillBlocks("")).toBe("");
  expect(stripLeadingSkillBlocks("hello")).toBe("hello");
  expect(stripLeadingSkillBlocks(`<skill name="dip" location="/x">body</skill>\n\n/dip start the server`)).toBe("/dip start the server");
  expect(stripLeadingSkillBlocks(`<skill name="dip" location="/x">dip body</skill>\n\n<skill name="tmux" location="/y">tmux body</skill>\n\n/tmux then /dip please`)).toBe("/tmux then /dip please");
  expect(stripLeadingSkillBlocks("intro text <skill name=\"dip\" location=\"/x\">body</skill> trailing")).toBe("intro text <skill name=\"dip\" location=\"/x\">body</skill> trailing");
  expect(stripLeadingSkillBlocks(`<skill name="dip" location="/x">\nline 1\nline 2\n\nline 4\n</skill>\n\nvisible`)).toBe("visible");
});
