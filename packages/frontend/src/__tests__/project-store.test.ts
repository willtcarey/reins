/**
 * Tests for ProjectStore — per-project task/session data cache.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { ProjectStore } from "../models/stores/project-store.js";
import { ProjectsStore } from "../models/stores/projects-store.js";
import type { TaskListItem } from "../models/tasks.js";
import { SessionCache } from "../models/stores/session-cache.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";
import type { SessionListItem } from "../models/ws-client.js";

// Mock fetch globally

function jsonResponse(data: unknown, ok = true): Response {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

function task(overrides: Partial<TaskListItem>): TaskListItem {
  return {
    id: 1,
    project_id: 42,
    title: "Task",
    description: null,
    branch_name: "task/example",
    status: "open",
    created_at: "",
    updated_at: "",
    session_count: 1,
    session_ids: ["s1"],
    diffStats: null,
    ...overrides,
  };
}

function session(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "s1",
    projectId: 42,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: "",
    updatedAt: "",
    messageCount: 0,
    firstMessage: null,
    activityState: null,
    ...overrides,
  };
}

describe("ProjectStore", () => {
  let store: ProjectStore;

  beforeEach(() => {
    store = new ProjectStore(42, new SessionCache());
    restoreFetch();
  });

  test("constructor sets projectId and initial state", () => {
    expect(store.projectId).toBe(42);
    expect(store.tasks).toEqual([]);
    expect(store.openTasks).toEqual([]);
    expect(store.closedTasks).toEqual([]);
    expect(store.sessionIds).toEqual([]);
    expect(store.sessions).toEqual([]);
    expect(store.loadedTaskSessionIds).toEqual(new Set());
    expect(store.taskSessionsFor(1)).toEqual([]);
    expect(store.loading).toBe(false);
    expect(store.loaded).toBe(false);
  });

  test("fetchLists remembers fetched session list metadata", async () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    const sessions = [session({ firstMessage: "hello", activityState: "running" })];

    mockFetch((url) => {
      if (url.includes("/tasks")) return jsonResponse([]);
      if (url.includes("/sessions")) return jsonResponse(sessions);
      return jsonResponse({}, false);
    });

    await store.fetchLists();

    expect(sessionCache.get("s1")?.projectId).toBe(42);
    expect(sessionCache.get("s1")?.firstMessage).toBe("hello");
    expect(sessionCache.get("s1")?.activityState).toBe("running");
  });

  test("fetchLists syncs session activity through SessionCache subscription", async () => {
    const sessionCache = new SessionCache();
    const projectsStore = new ProjectsStore(sessionCache);
    store = projectsStore.getStore(42);

    mockFetch((url) => {
      if (url.includes("/tasks")) return jsonResponse([]);
      if (url.includes("/sessions")) return jsonResponse([session({ activityState: "running" })]);
      return jsonResponse({}, false);
    });

    await store.fetchLists();

    expect(store.activityForSession("s1")).toBe("running");

    sessionCache.set("s1", { activityState: null });

    expect(store.activityForSession("s1")).toBeNull();
  });

  test("fetchTaskSessions syncs session activity through SessionCache subscription", async () => {
    const sessionCache = new SessionCache();
    const projectsStore = new ProjectsStore(sessionCache);
    store = projectsStore.getStore(42);

    mockFetch(() => jsonResponse([session({ id: "s-task", taskId: 1, activityState: "finished" })]));

    await store.fetchTaskSessions(1);

    expect(store.activityForSession("s-task")).toBe("finished");
  });

  test("openTasks and closedTasks split task rows", () => {
    const open = task({ id: 1, status: "open" });
    const closed = task({ id: 2, status: "closed" });
    store.tasks = [open, closed];

    expect(store.openTasks).toEqual([open]);
    expect(store.closedTasks).toEqual([closed]);
  });

  test("fetchLists fetches tasks and sessions in parallel", async () => {
    const sessionIds: string[] = [];
    const tasks = [{ id: 1, project_id: 42, title: "Task 1", description: null, branch_name: "", status: "open" as const, created_at: "", updated_at: "", session_count: 0, session_ids: sessionIds, diffStats: null }];
    const sessions = [session()];

    mockFetch((url) => {
      if (url.includes("/tasks")) return jsonResponse(tasks);
      if (url.includes("/sessions")) return jsonResponse(sessions);
      return jsonResponse({}, false);
    });

    await store.fetchLists();

    expect(store.tasks).toEqual(tasks);
    expect(store.openTasks).toEqual(tasks);
    expect(store.closedTasks).toEqual([]);
    expect(store.sessionIds).toEqual(["s1"]);
    expect(store.sessions).toMatchObject(sessions);
    expect(store.loading).toBe(false);
    expect(store.loaded).toBe(true);
  });

  test("fetchLists sets loading during fetch", async () => {
    const states: boolean[] = [];

    store.subscribe(() => {
      states.push(store.loading);
    });

    mockFetch(() => jsonResponse([]));

    await store.fetchLists();

    // First notification: loading=true, second: loading=false
    expect(states[0]).toBe(true);
    expect(states[states.length - 1]).toBe(false);
  });

  test("fetchLists sets loaded=true only on success", async () => {
    mockFetch(() => jsonResponse([]));
    await store.fetchLists();
    expect(store.loaded).toBe(true);
  });

  test("fetchLists handles fetch errors gracefully", async () => {
    mockFetch(() => { throw new Error("network error"); });
    await store.fetchLists();
    expect(store.loading).toBe(false);
    expect(store.loaded).toBe(false);
    expect(store.tasks).toEqual([]);
    expect(store.sessions).toEqual([]);
  });

  test("fetchLists handles non-ok responses", async () => {
    mockFetch(() => jsonResponse({}, false));
    await store.fetchLists();
    // Non-ok responses don't update data but don't throw
    expect(store.loading).toBe(false);
  });

  test("fetchTaskSessions fetches and caches task sessions", async () => {
    const taskSessions = [session({ id: "s2", taskId: 1 })];

    mockFetch((url) => {
      if (url.includes("/tasks/1/sessions")) return jsonResponse(taskSessions);
      return jsonResponse({}, false);
    });

    await store.fetchTaskSessions(1);

    expect(store.loadedTaskSessionIds.has(1)).toBe(true);
    expect(store.taskSessionsFor(1)).toMatchObject(taskSessions);
  });

  test("fetchTaskSessions skips update if data unchanged", async () => {
    const taskSessions = [session({ id: "s2", taskId: 1 })];
    let notifyCount = 0;

    mockFetch(() => jsonResponse(taskSessions));

    store.subscribe(() => { notifyCount++; });

    await store.fetchTaskSessions(1);
    const countAfterFirst = notifyCount;

    await store.fetchTaskSessions(1);
    // Should not have notified again since data is the same
    expect(notifyCount).toBe(countAfterFirst);
  });

  test("fetchTaskSessions notifies on metadata change with unchanged ordering", async () => {
    let notifyCount = 0;
    store.subscribe(() => { notifyCount++; });

    mockFetch(() => jsonResponse([session({ id: "s2", taskId: 1, name: "V1" })]));
    await store.fetchTaskSessions(1);
    const countAfterFirst = notifyCount;

    mockFetch(() => jsonResponse([session({ id: "s2", taskId: 1, name: "V2" })]));
    await store.fetchTaskSessions(1);

    expect(store.loadedTaskSessionIds.has(1)).toBe(true);
    expect(store.taskSessionsFor(1)[0]?.name).toBe("V2");
    expect(notifyCount).toBeGreaterThan(countAfterFirst);
  });

  test("getSession returns project-scoped cached session metadata", () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);

    sessionCache.set("s1", session({ id: "s1", taskId: 7 }));
    sessionCache.set("other-project", session({ id: "other-project", projectId: 99, taskId: 7 }));

    expect(store.getSession("s1")?.taskId).toBe(7);
    expect(store.getSession("other-project")).toBeUndefined();
    expect(store.getSession("missing")).toBeUndefined();
  });

  test("taskSessionsFor derives cached sessions by taskId", () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);

    sessionCache.set("older", session({ id: "older", taskId: 1, updatedAt: "2024-01-01T00:00:00Z" }));
    sessionCache.set("newer", session({ id: "newer", taskId: 1, updatedAt: "2024-01-02T00:00:00Z" }));
    sessionCache.set("other-task", session({ id: "other-task", taskId: 2 }));
    sessionCache.set("scratch", session({ id: "scratch", taskId: null }));
    sessionCache.set("other-project", session({ id: "other-project", projectId: 99, taskId: 1 }));

    expect(store.taskSessionsFor(1).map((s) => s.id)).toEqual(["newer", "older"]);
    expect(store.taskSessionsFor(2).map((s) => s.id)).toEqual(["other-task"]);
  });

  test("fetchTaskSessions handles errors gracefully", async () => {
    mockFetch(() => { throw new Error("network error"); });
    await store.fetchTaskSessions(1);
    expect(store.taskSessionsFor(1)).toEqual([]);
  });

  test("subscribe returns unsubscribe function", async () => {
    let count = 0;
    const unsub = store.subscribe(() => { count++; });

    mockFetch(() => jsonResponse([]));
    await store.fetchLists();
    const countBefore = count;

    unsub();
    await store.fetchLists();
    expect(count).toBe(countBefore);
  });

  test("fetchLists uses correct URLs for projectId", async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return jsonResponse([]);
    });

    await store.fetchLists();

    expect(urls).toContain("/api/projects/42/tasks");
    expect(urls).toContain("/api/projects/42/sessions");
  });

  test("fetchTaskSessions uses correct URL", async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return jsonResponse([]);
    });

    await store.fetchTaskSessions(7);

    expect(urls).toContain("/api/tasks/7/sessions");
  });

  test("fetchLists refreshes already-loaded task session lists", async () => {
    store.loadedTaskSessionIds = new Set([7]);

    mockFetch((url) => {
      if (url === "/api/projects/42/tasks") {
        return jsonResponse([
          {
            id: 7,
            project_id: 42,
            title: "Task 7",
            description: null,
            branch_name: "task/task-7",
            status: "open" as const,
            created_at: "",
            updated_at: "",
            session_count: 1,
            session_ids: ["s-new"],
            diffStats: null,
          },
        ]);
      }
      if (url === "/api/projects/42/sessions") {
        return jsonResponse([]);
      }
      if (url === "/api/tasks/7/sessions") {
        return jsonResponse([
          session({ id: "s-new", taskId: 7, messageCount: 2, firstMessage: "Hello" }),
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchLists();

    expect(store.loadedTaskSessionIds.has(7)).toBe(true);
    expect(store.taskSessionsFor(7)).toMatchObject([
      session({ id: "s-new", taskId: 7, messageCount: 2, firstMessage: "Hello" }),
    ]);
  });

  test("exposes activity selectors from SessionCache", () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    store.tasks = [task({ id: 1, session_ids: [] })];

    sessionCache.set("s1", { projectId: 42, taskId: 1, activityState: "running" });

    expect(store.activityForSession("s1")).toBe("running");
    expect(store.activityForTask(1)).toBe("running");
    expect(store.activityState).toBe("running");
  });

  test("activityForTask derives by cached taskId and prioritizes running", () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);

    sessionCache.set("finished", { projectId: 42, taskId: 7, activityState: "finished" });
    sessionCache.set("running", { projectId: 42, taskId: 7, activityState: "running" });
    sessionCache.set("other-task", { projectId: 42, taskId: 8, activityState: "running" });
    sessionCache.set("other-project", { projectId: 99, taskId: 7, activityState: "running" });

    expect(store.activityForTask(7)).toBe("running");
    expect(store.activityForTask(8)).toBe("running");
    expect(store.activityForTask(9)).toBeNull();

    sessionCache.set("running", { activityState: null });
    expect(store.activityForTask(7)).toBe("finished");
  });

  test("activityState derives running over finished", () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    store.tasks = [task({ id: 1, session_ids: ["s1"] })];
    store.sessionIds = ["s2"];

    sessionCache.set("s1", { projectId: 42, activityState: "running" });
    sessionCache.set("s2", { projectId: 42, activityState: "finished" });

    // Running wins
    expect(store.activityState).toBe("running");

    sessionCache.set("s1", { activityState: null });
    // Now only finished remains
    expect(store.activityState).toBe("finished");
  });
});
