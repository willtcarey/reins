import type { TaskWithDiffStats as TaskListItem } from "@backend/models/tasks.js";

/** Build a valid task list row with focused overrides for the behavior under test. */
export function makeTask(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id: 1,
    project_id: 1,
    title: "Task",
    description: null,
    branch_name: "task/example",
    base_commit: null,
    status: "open",
    created_at: "",
    updated_at: "",
    closed_at: null,
    session_count: 0,
    session_ids: [],
    diffStats: null,
    ...overrides,
  };
}
