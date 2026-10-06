/**
 * Tests for ProjectStore — per-project task/session data cache.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { ProjectStore } from "../models/stores/project-store.js";
import { ProjectsStore } from "../models/stores/projects-store.js";
import { SessionCache } from "../models/stores/session-cache.js";
import { makeTask } from "./helpers/fixtures.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";
import type { SessionListView as SessionListItem } from "@backend/models/sessions.js";

// Mock fetch globally

function jsonResponse(data: unknown, ok = true): Response {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
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
    pinnedAt: null,
    archivedAt: null,
    placement: { available: true, nodeId: "internal", nodeName: "Internal", path: "" },
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

  test("selects only running immediate children of a session", () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    sessionCache.setMany([
      session({ id: "running-child", parentSessionId: "parent", activityState: "running" }),
      session({ id: "finished-child", parentSessionId: "parent", activityState: "finished" }),
      session({ id: "grandchild", parentSessionId: "running-child", activityState: "running" }),
      session({ id: "other-parent-child", parentSessionId: "other", activityState: "running" }),
      session({ id: "other-project-child", projectId: 99, parentSessionId: "parent", activityState: "running" }),
    ]);

    expect(store.runningChildSessionsFor("parent").map((child) => child.id)).toEqual([
      "running-child",
    ]);
  });

  test("marks session activity read and unread", async () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    sessionCache.setMany([session({ id: "s-task", activityState: "finished" })]);
    const requests: RequestInit[] = [];
    mockFetch((_url, init) => {
      requests.push(init ?? {});
      return jsonResponse({ ok: true });
    });

    expect(await store.setSessionUnread("s-task", false)).toEqual({ ok: true });
    expect(store.activityForSession("s-task")).toBeNull();
    expect(JSON.parse(String(requests[0]?.body))).toEqual({ unread: false });

    expect(await store.setSessionUnread("s-task", true)).toEqual({ ok: true });
    expect(store.activityForSession("s-task")).toBe("finished");
    expect(JSON.parse(String(requests[1]?.body))).toEqual({ unread: true });
  });

  test("restores session activity when marking it read fails", async () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    sessionCache.setMany([session({ id: "s-task", activityState: "finished" })]);
    mockFetch(() => jsonResponse({}, false));

    expect(await store.setSessionUnread("s-task", false)).toEqual({ error: "HTTP 500" });
    expect(store.activityForSession("s-task")).toBe("finished");
  });

  test("fetchLists fetches tasks and sessions in parallel", async () => {
    const sessionIds: string[] = [];
    const tasks = [{ id: 1, project_id: 42, title: "Task 1", description: null, branch_name: "", base_commit: null, status: "open" as const, created_at: "", updated_at: "", session_count: 0, session_ids: sessionIds, diffStats: null }];
    const sessions = [session()];

    mockFetch((url) => {
      if (url.includes("/tasks")) return jsonResponse(tasks);
      if (url.includes("/sessions")) return jsonResponse(sessions);
      return jsonResponse({}, false);
    });

    await store.fetchLists();

    expect(store.tasks).toEqual(tasks);
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

  test("orders pinned sessions above unpinned sessions while preserving recency", () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);

    sessionCache.setMany([
      session({ id: "older", taskId: 1, updatedAt: "2024-01-01T00:00:00Z" }),
      session({ id: "newer", taskId: 1, updatedAt: "2024-01-04T00:00:00Z" }),
      session({ id: "pinned-older", taskId: 1, updatedAt: "2024-01-02T00:00:00Z", pinnedAt: "2024-01-05T00:00:00Z" }),
      session({ id: "pinned-newer", taskId: 1, updatedAt: "2024-01-03T00:00:00Z", pinnedAt: "2024-01-06T00:00:00Z" }),
    ]);

    expect(store.taskSessionsFor(1).map((s) => s.id)).toEqual([
      "pinned-newer",
      "pinned-older",
      "newer",
      "older",
    ]);
  });

  test("optimistically updates session metadata and keeps pin and archive independent", async () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    sessionCache.set("s1", session({ pinnedAt: "2024-01-01T00:00:00Z" }));
    let resolveRequest!: (response: Response) => void;
    mockFetch(() => new Promise<Response>((resolve) => { resolveRequest = resolve; }));

    const request = store.updateSessionMetadata("s1", { archived: true });

    expect(sessionCache.get("s1")?.archivedAt).toEqual(expect.any(String));
    expect(sessionCache.get("s1")?.pinnedAt).toBe("2024-01-01T00:00:00Z");
    resolveRequest(jsonResponse({
      ...session(),
      pinnedAt: "2024-01-01T00:00:00Z",
      archivedAt: "2024-02-01T00:00:00Z",
    }));
    expect(await request).toEqual({ ok: true });
    expect(sessionCache.get("s1")?.archivedAt).toBe("2024-02-01T00:00:00Z");
    expect(sessionCache.get("s1")?.pinnedAt).toBe("2024-01-01T00:00:00Z");
  });

  test("optimistically renames a session and clears its custom name", async () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    sessionCache.set("s1", session({ name: "Old name", firstMessage: "Fallback prompt" }));
    const requests: Array<{ url: string; init: RequestInit }> = [];
    mockFetch((url, init) => {
      requests.push({ url, init: init ?? {} });
      const body: { name: string | null } = JSON.parse(String(init?.body));
      return jsonResponse({ ...session(), name: body.name?.trim() || null });
    });

    expect(await store.updateSessionMetadata("s1", { name: "  New name  " })).toEqual({ ok: true });
    expect(sessionCache.get("s1")?.name).toBe("New name");
    expect(requests[0]?.url).toBe("/api/sessions/s1/metadata");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ name: "  New name  " });

    expect(await store.updateSessionMetadata("s1", { name: null })).toEqual({ ok: true });
    expect(sessionCache.get("s1")?.name).toBeNull();
    expect(sessionCache.get("s1")?.firstMessage).toBe("Fallback prompt");
  });

  test("rolls back only the explicit metadata field when the request fails", async () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    sessionCache.set("s1", session({ pinnedAt: null, archivedAt: "2024-01-01T00:00:00Z" }));
    mockFetch(() => jsonResponse({}, false));

    expect(await store.updateSessionMetadata("s1", { pinned: true })).toEqual({ error: "HTTP 500" });
    expect(sessionCache.get("s1")?.pinnedAt).toBeNull();
    expect(sessionCache.get("s1")?.archivedAt).toBe("2024-01-01T00:00:00Z");
  });

  test("moves a session to a node and caches the placement the server answers with", async () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    sessionCache.set("s1", session());
    const requests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    mockFetch((url, init) => {
      requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/sessions/s1/move-targets") return jsonResponse([{ nodeId: "internal", name: "Internal", connected: true, eligible: true }]);
      if (url === "/api/sessions/s1/move") return jsonResponse({ available: true, nodeId: "internal", nodeName: "Internal", path: "" });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    expect(await store.loadMoveTargets("s1")).toEqual([{ nodeId: "internal", name: "Internal", connected: true, eligible: true }]);
    expect(await store.moveSession("s1", "internal")).toEqual({ ok: true });

    expect(requests.slice(1).map(({ url, method, body }) => [url, method, body])).toEqual([
      ["/api/sessions/s1/move", "POST", { nodeId: "internal" }],
    ]);
    expect(store.getSession("s1")?.placement).toEqual({ available: true, nodeId: "internal", nodeName: "Internal", path: "" });
  });

  test("reports a refused move with the server's reason and leaves the session where it is", async () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    sessionCache.set("s1", session());
    mockFetch(() => new Response(JSON.stringify({ error: "Session has an active run or pending input; try again when it is idle" }), { status: 409 }));

    expect(await store.moveSession("s1", "internal")).toEqual({ error: "Session has an active run or pending input; try again when it is idle" });
    expect(await store.loadMoveTargets("s1")).toEqual({ error: "Session has an active run or pending input; try again when it is idle" });
    expect(store.getSession("s1")?.placement).toEqual({ available: true, nodeId: "internal", nodeName: "Internal", path: "" });
  });

  test("sorts pinned scratch sessions above newer unpinned sessions", () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    sessionCache.setMany([
      session({ id: "newer", updatedAt: "2024-01-03T00:00:00Z" }),
      session({ id: "pinned", updatedAt: "2024-01-01T00:00:00Z", pinnedAt: "2024-01-02T00:00:00Z" }),
      session({ id: "older", updatedAt: "2024-01-02T00:00:00Z" }),
    ]);
    store.sessionIds = ["newer", "pinned", "older"];

    expect(store.sessions.map((item) => item.id)).toEqual(["pinned", "newer", "older"]);
  });

  test("normal list refresh hides archived sessions without clearing direct metadata", async () => {
    const sessionCache = new SessionCache();
    store = new ProjectStore(42, sessionCache);
    sessionCache.set("archived", session({ id: "archived", archivedAt: "2024-01-01T00:00:00Z" }));
    store.sessionIds = ["archived"];
    mockFetch((url) => {
      if (url.includes("/tasks")) return jsonResponse([]);
      if (url.includes("/sessions")) return jsonResponse([]);
      return jsonResponse({}, false);
    });

    await store.fetchLists();

    expect(store.sessions).toEqual([]);
    expect(sessionCache.get("archived")?.archivedAt).toBe("2024-01-01T00:00:00Z");
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

    expect(urls).toContain("/api/projects/42/tasks?status=open");
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
      if (url === "/api/projects/42/tasks?status=open") {
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
    store.tasks = [makeTask({ id: 1, session_ids: [] })];

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
    store.tasks = [makeTask({ id: 1, session_ids: ["s1"] })];
    store.sessionIds = ["s2"];

    sessionCache.set("s1", { projectId: 42, activityState: "running" });
    sessionCache.set("s2", { projectId: 42, activityState: "finished" });

    // Running wins
    expect(store.activityState).toBe("running");

    sessionCache.set("s1", { activityState: null });
    // Now only finished remains
    expect(store.activityState).toBe("finished");
  });
  test("skill suggestions keep the last known list while the node cannot answer", async () => {
    let available = true;
    mockFetch((url) => url === "/api/projects/42/skills"
      ? jsonResponse(available ? { skills: [{ name: "review", description: "Reviews code" }], available } : { skills: [], available })
      : jsonResponse([]));
    await store.fetchLists();
    expect(store.skills).toEqual([{ name: "review", description: "Reviews code" }]);

    available = false;
    await store.fetchSkills();
    await store.fetchLists();
    expect(store.skills).toEqual([{ name: "review", description: "Reviews code" }]);
  });
});
