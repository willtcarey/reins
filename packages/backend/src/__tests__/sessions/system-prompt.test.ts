import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { reinsSystemPrompt } from "../../sessions/system-prompt.js";

// Fixtures pin the server's sections as they were cut from the prompt the node used to render whole.
const expected = (name: string) => readFileSync(new URL(`../fixtures/system-prompt/${name}.txt`, import.meta.url), "utf8");

describe("reinsSystemPrompt", () => {
  test("a task session is told its task", () => {
    expect(reinsSystemPrompt({ task: { title: "Fix login bug", description: "Users can't log in" } })).toBe(expected("task"));
  });

  test("a scratch session is a project assistant session", () => {
    expect(reinsSystemPrompt({ task: null })).toBe(expected("scratch"));
  });

  test("session orchestration is described only when the session is offered execute", () => {
    expect(reinsSystemPrompt({ task: { title: "T", description: null }, tools: ["read", "write", "edit", "bash"] })).toBe(expected("task-no-description-no-execute"));
    expect(reinsSystemPrompt({ task: null, tools: ["execute"] })).toContain("Session orchestration (through execute)");
  });
});
