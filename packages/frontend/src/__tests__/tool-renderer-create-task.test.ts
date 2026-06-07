import { describe, test, expect } from "bun:test";
import { getTaskSummary, getTaskDetail } from "../models/tools/create-task.js";
import type { ToolBlockData } from "../models/chat-state.js";

function makeCreateTaskBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    id: "task-test-id",
    name: "create_task",
    args: { title: "Add dark mode", description: "Implement dark mode toggle in settings panel", branch_name: "task/dark-mode" },
    status: "done",
    ...overrides,
  };
}

describe("create_task tool model helpers", () => {
  test("extracts the task title, description, and branch", () => {
    expect(getTaskSummary(makeCreateTaskBlock())).toBe("Add dark mode");
    expect(getTaskDetail(makeCreateTaskBlock())).toEqual({
      description: "Implement dark mode toggle in settings panel",
      branch: "task/dark-mode",
    });
  });

  test("uses empty strings when optional args are missing", () => {
    expect(getTaskSummary(makeCreateTaskBlock({ args: {} }))).toBe("");
    expect(getTaskDetail(makeCreateTaskBlock({ args: undefined }))).toEqual({ description: "", branch: "" });
    expect(getTaskDetail(makeCreateTaskBlock({ args: { title: "Test", description: "Desc" } }))).toEqual({ description: "Desc", branch: "" });
  });
});
