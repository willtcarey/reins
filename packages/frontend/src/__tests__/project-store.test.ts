/**
 * Tests for ProjectStore — per-project task/session data cache.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { ProjectStore } from "../models/stores/project-store.js";
import { ProjectsStore } from "../models/stores/projects-store.js";
import { TasksCollection, type TaskListItem } from "../models/tasks.js";
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
    expect(store.tasks).toBeInstanceOf(TasksCollection);
    expect(store.tasks.projectId).toBe(42);
    expect(store.tasks.items).toEqual([]);
    expect(store.sessions).toEqual([]);
    expect(store.taskSessions).toEqual(new Map());
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

    expect(store.tasks).toBeInstanceOf(TasksCollection);
    expect(store.tasks.items).toEqual(tasks);
    expect(store.sessions).toEqual(sessions);
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
    expect(store.tasks.items).toEqual([]);
    expect(store.sessions).toEqual([]);
  });

  test("fetchLists handles non-ok responses", async () => {
    mockFetch(() => jsonResponse({}, false));
    await store.fetchLists();
    // Non-ok responses don't update data but don't throw
    expect(store.loading).toBe(false);
  });

  test("fetchTaskSessions fetches and caches task sessions", async () => {
    const taskSessions = [session({ id: "s2" })];

    mockFetch((url) => {
      if (url.includes("/tasks/1/sessions")) return jsonResponse(taskSessions);
      return jsonResponse({}, false);
    });

    await store.fetchTaskSessions(1);

    expect(store.taskSessions.get(1)).toEqual(taskSessions);
  });

  test("fetchTaskSessions skips update if data unchanged", async () => {
    const taskSessions = [session({ id: "s2" })];
    let notifyCount = 0;

    mockFetch(() => jsonResponse(taskSessions));

    store.subscribe(() => { notifyCount++; });

    await store.fetchTaskSessions(1);
    const countAfterFirst = notifyCount;

    await store.fetchTaskSessions(1);
    // Should not have notified again since data is the same
    expect(notifyCount).toBe(countAfterFirst);
  });

  test("fetchTaskSessions notifies on data change", async () => {
    let notifyCount = 0;
    store.subscribe(() => { notifyCount++; });

    mockFetch(() => jsonResponse([session({ name: "V1" })]));
    await store.fetchTaskSessions(1);
    const countAfterFirst = notifyCount;

    mockFetch(() => jsonResponse([session({ name: "V2" })]));
    await store.fetchTaskSessions(1);
    expect(notifyCount).toBeGreaterThan(countAfterFirst);
  });

  test("fetchTaskSessions handles errors gracefully", async () => {
    mockFetch(() => { throw new Error("network error"); });
    await store.fetchTaskSessions(1);
    expect(store.taskSessions.get(1)).toBeUndefined();
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
    store.taskSessions = new Map([
      [
        7,
        [session({ id: "s-old" })],
      ],
    ]);

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
          session({ id: "s-new", messageCount: 2, firstMessage: "Hello" }),
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchLists();

    expect(store.taskSessions.get(7)).toEqual([
      session({ id: "s-new", messageCount: 2, firstMessage: "Hello" }),
    ]);
  });

  test("exposes activity selectors from SessionCache", () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    store.tasks = new TasksCollection(42, [task({ id: 1, session_ids: ["s1"] })]);

    sessionCache.set("s1", { projectId: 42, activityState: "running" });

    expect(store.activityForSession("s1")).toBe("running");
    expect(store.tasksWithActivity.activityForId(1)).toBe("running");
    expect(store.activityState).toBe("running");
  });

  test("activityState derives running over finished", () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    store.tasks = new TasksCollection(42, [task({ id: 1, session_ids: ["s1"] })]);
    store.sessions = [session({ id: "s2" })];

    sessionCache.set("s1", { projectId: 42, activityState: "running" });
    sessionCache.set("s2", { projectId: 42, activityState: "finished" });

    // Running wins
    expect(store.activityState).toBe("running");

    sessionCache.set("s1", { activityState: null });
    // Now only finished remains
    expect(store.activityState).toBe("finished");
  });
});
