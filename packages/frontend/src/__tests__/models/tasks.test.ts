import { describe, expect, test } from "bun:test";
import { TasksCollection, type TaskListItem } from "../../models/tasks.js";
import type { ActivityState } from "../../models/stores/session-cache.js";

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

function collection(
  tasks: TaskListItem[],
  activityMap: ReadonlyMap<string, ActivityState> = new Map(),
): TasksCollection {
  return new TasksCollection(42, tasks, activityMap);
}

describe("TasksCollection", () => {
  test("splits open and closed tasks", () => {
    const open = task({ id: 1, status: "open" });
    const closed = task({ id: 2, status: "closed" });
    const tasks = collection([open, closed]);

    expect(tasks.open).toEqual([open]);
    expect(tasks.closed).toEqual([closed]);
  });

  test("activityFor prioritizes running over finished for open tasks", () => {
    const activityMap = new Map<string, ActivityState>([
      ["s1", "finished"],
      ["s2", "running"],
    ]);

    expect(collection([], activityMap).activityFor(task({ session_ids: ["s1", "s2"] }))).toBe("running");
  });

  test("activityFor returns finished when an open task only has unread completions", () => {
    const activityMap = new Map<string, ActivityState>([["s1", "finished"]]);

    expect(collection([], activityMap).activityFor(task({ session_ids: ["s1"] }))).toBe("finished");
  });

  test("activityByTask aggregates activity by task id", () => {
    const activityMap = new Map<string, ActivityState>([
      ["s1", "finished"],
      ["s2", "running"],
      ["s3", "running"],
    ]);

    expect(collection([
      task({ id: 1, session_ids: ["s1"] }),
      task({ id: 2, session_ids: ["s2"] }),
      task({ id: 3, session_ids: ["s3"] }),
    ], activityMap).activityByTask).toEqual(new Map([
      [1, "finished"],
      [2, "running"],
      [3, "running"],
    ]));
  });

  test("withActivity returns a collection with the same tasks and new activity map", () => {
    const base = collection([task({ id: 7, session_ids: ["s7"] })]);
    const withActivity = base.withActivity(new Map([["s7", "running"]]));

    expect(withActivity).not.toBe(base);
    expect(withActivity.projectId).toBe(42);
    expect(withActivity.items).toBe(base.items);
    expect(base.activityForId(7)).toBeUndefined();
    expect(withActivity.activityForId(7)).toBe("running");
  });

  test("activityForId resolves activity by task id", () => {
    const tasks = collection(
      [task({ id: 7, session_ids: ["s7"] })],
      new Map([["s7", "running"]]),
    );

    expect(tasks.activityForId(7)).toBe("running");
    expect(tasks.activityForId(8)).toBeUndefined();
  });

  test("findBySessionId finds the task containing a session", () => {
    const match = task({ id: 2, session_ids: ["s2"] });
    const tasks = collection([
      task({ id: 1, session_ids: ["s1"] }),
      match,
    ]);

    expect(tasks.findBySessionId("s2")).toBe(match);
    expect(tasks.findBySessionId("missing")).toBeUndefined();
  });
});
