/**
 * Tests for ProjectStore — per-project task/session data cache.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { ProjectStore } from "../stores/project-store.js";

// Mock fetch globally
const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url));
  }) as any;
}

function jsonResponse(data: unknown, ok = true): Response {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ProjectStore", () => {
  let store: ProjectStore;

  beforeEach(() => {
    store = new ProjectStore(42);
    globalThis.fetch = originalFetch;
  });

  test("constructor sets projectId and initial state", () => {
    expect(store.projectId).toBe(42);
    expect(store.tasks).toEqual([]);
    expect(store.sessions).toEqual([]);
    expect(store.taskSessions).toEqual(new Map());
    expect(store.loading).toBe(false);
    expect(store.loaded).toBe(false);
  });

  test("fetchLists fetches tasks and sessions in parallel", async () => {
    const tasks = [{ id: 1, title: "Task 1", session_count: 0, branch_name: null, created_at: "" }];
    const sessions = [{ id: "s1", title: "Session 1", task_id: null, created_at: "", model: "test" }];

    mockFetch((url) => {
      if (url.includes("/tasks")) return jsonResponse(tasks);
      if (url.includes("/sessions")) return jsonResponse(sessions);
      return jsonResponse({}, false);
    });

    await store.fetchLists();

    expect(store.tasks).toEqual(tasks);
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
    const taskSessions = [{ id: "s2", title: "Task Session", task_id: 1, created_at: "", model: "test" }];

    mockFetch((url) => {
      if (url.includes("/tasks/1/sessions")) return jsonResponse(taskSessions);
      return jsonResponse({}, false);
    });

    await store.fetchTaskSessions(1);

    expect(store.taskSessions.get(1)).toEqual(taskSessions);
  });

  test("fetchTaskSessions skips update if data unchanged", async () => {
    const taskSessions = [{ id: "s2", title: "Task Session", task_id: 1, created_at: "", model: "test" }];
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

    mockFetch(() => jsonResponse([{ id: "s1", title: "V1", task_id: 1, created_at: "", model: "test" }]));
    await store.fetchTaskSessions(1);
    const countAfterFirst = notifyCount;

    mockFetch(() => jsonResponse([{ id: "s1", title: "V2", task_id: 1, created_at: "", model: "test" }]));
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
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      return Promise.resolve(jsonResponse([]));
    }) as any;

    await store.fetchLists();

    expect(urls).toContain("/api/projects/42/tasks");
    expect(urls).toContain("/api/projects/42/sessions");
  });

  test("fetchTaskSessions uses correct URL", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      return Promise.resolve(jsonResponse([]));
    }) as any;

    await store.fetchTaskSessions(7);

    expect(urls).toContain("/api/tasks/7/sessions");
  });
});
