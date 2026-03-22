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

describe("getTaskSummary", () => {
  test("returns task title from args", () => {
    expect(getTaskSummary(makeCreateTaskBlock())).toBe("Add dark mode");
  });

  test("returns empty string when args has no title", () => {
    expect(getTaskSummary(makeCreateTaskBlock({ args: {} }))).toBe("");
  });

  test("returns empty string when args is undefined", () => {
    expect(getTaskSummary(makeCreateTaskBlock({ args: undefined as any }))).toBe("");
  });
});

describe("getTaskDetail", () => {
  test("returns description and branch", () => {
    expect(getTaskDetail(makeCreateTaskBlock())).toEqual({
      description: "Implement dark mode toggle in settings panel",
      branch: "task/dark-mode",
    });
  });

  test("returns empty strings when args are missing", () => {
    expect(getTaskDetail(makeCreateTaskBlock({ args: {} }))).toEqual({
      description: "",
      branch: "",
    });
  });

  test("returns empty strings when args is undefined", () => {
    expect(getTaskDetail(makeCreateTaskBlock({ args: undefined as any }))).toEqual({
      description: "",
      branch: "",
    });
  });

  test("handles missing branch gracefully", () => {
    const block = makeCreateTaskBlock({ args: { title: "Test", description: "Desc" } });
    expect(getTaskDetail(block)).toEqual({
      description: "Desc",
      branch: "",
    });
  });
});
