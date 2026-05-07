import { describe, expect, test } from "bun:test";
import { TaskListItemElement } from "../../components/task-list-item.js";
import type { TaskListItem } from "../../models/tasks.js";

function task(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id: 1,
    project_id: 42,
    title: "Task",
    description: null,
    branch_name: "task/example",
    status: "open",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    session_count: 1,
    session_ids: ["s1"],
    diffStats: null,
    ...overrides,
  };
}

describe("TaskListItem activity", () => {
  test("uses parent-derived task activity instead of deriving from session activity", () => {
    const el = new TaskListItemElement();
    el.task = task({ status: "closed" });
    el.activityMap = new Map([["s1", "running"]]);

    expect(el.activityState).toBeUndefined();

    el.activityState = "running";

    expect(el.activityState).toBe("running");
  });
});
