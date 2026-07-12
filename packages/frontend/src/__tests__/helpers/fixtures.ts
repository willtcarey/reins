import type { TaskListItem } from "../../models/tasks.js";

/** Build a valid task list row with focused overrides for the behavior under test. */
export function makeTask(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id: 1,
    project_id: 1,
    title: "Task",
    description: null,
    branch_name: "task/example",
    status: "open",
    created_at: "",
    updated_at: "",
    session_count: 0,
    session_ids: [],
    diffStats: null,
    ...overrides,
  };
}
