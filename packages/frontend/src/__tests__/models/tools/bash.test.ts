import { describe, expect, test } from "bun:test";
import { COMMAND_LINES, shownCommand } from "../../../models/tools/bash.js";

const long = Array.from({ length: COMMAND_LINES + 5 }, (_, index) => `line ${index + 1}`).join("\n");

describe("shownCommand", () => {
  test("a short command is shown whole", () => {
    expect(shownCommand("ls\npwd", { writing: false, expanded: false })).toEqual({ text: "ls\npwd", before: 0, after: 0 });
  });

  test("a long command being written shows its newest lines", () => {
    const shown = shownCommand(long, { writing: true, expanded: false });

    expect(shown.text.split("\n")).toEqual(Array.from({ length: COMMAND_LINES }, (_, index) => `line ${index + 6}`));
    expect(shown).toMatchObject({ before: 5, after: 0 });
  });

  test("a long command once written shows its first lines, and all of them expanded", () => {
    const shown = shownCommand(long, { writing: false, expanded: false });

    expect(shown.text.split("\n")[0]).toBe("line 1");
    expect(shown.text.split("\n")).toHaveLength(COMMAND_LINES);
    expect(shown).toMatchObject({ before: 0, after: 5 });
    expect(shownCommand(long, { writing: false, expanded: true })).toEqual({ text: long, before: 0, after: 0 });
  });
});
