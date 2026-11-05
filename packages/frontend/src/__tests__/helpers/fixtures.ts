import type { TaskWithDiffStats as TaskListItem } from "@backend/models/tasks.js";
import type { SessionListView } from "@backend/models/sessions.js";
import type { ProjectView } from "@backend/routes/projects.js";
import type { SessionSummary, Task } from "@reins/sdk";

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

/** A session as the server's session lists give it, of project 1 by default, on the internal node. */
export function makeSessionListItem(id: string, overrides: Partial<SessionListView> = {}): SessionListView {
  return {
    id,
    projectId: 1,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    activityState: null,
    placement: { available: true, removed: false, nodeId: "internal", nodeName: "Internal", path: "/work" },
    pinnedAt: null,
    archivedAt: null,
    sourceExtension: null,
    messageCount: 1,
    firstMessage: `First message of ${id}`,
    ...overrides,
  };
}

/** A project as the server lists it. */
export function makeProject(id: number, name: string, overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    id,
    name,
    base_branch: "main",
    default_source_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    last_opened_at: "2026-01-01T00:00:00.000Z",
    defaultSource: null,
    ...overrides,
  };
}

/** The SDK's view of a session, for components that are given one: `makeSessionListItem`'s, in its terms. */
export function makeSessionSummary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    projectId: 1,
    taskId: null,
    parentSessionId: null,
    name: null,
    firstMessage: `First message of ${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    activity: null,
    pinned: false,
    archived: false,
    startedBy: null,
    source: { nodeId: "internal", path: "/work" },
    nodeName: "Internal",
    nodeRemoved: false,
    ...overrides,
  };
}

/** The SDK's view of a task, for components that are given one. */
export function makeTaskSummary(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 1,
    title: "Task",
    description: null,
    branchName: "task/example",
    closed: false,
    updatedAt: "",
    sessionCount: 0,
    diffStats: null,
    activity: null,
    ...overrides,
  };
}
