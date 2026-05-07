/**
 * Tests for ProjectsStore — project list, CRUD, and per-project data stores.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { ProjectsStore } from "../models/stores/projects-store.js";
import { ProjectStore } from "../models/stores/project-store.js";
import type { TaskListItem } from "../models/tasks.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";

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

describe("ProjectsStore per-project data", () => {
  let store: ProjectsStore;

  beforeEach(() => {
    store = new ProjectsStore();
    restoreFetch();
  });

  // ---- Lazy creation --------------------------------------------------------

  test("getStore creates a ProjectStore on first call", () => {
    const child = store.getStore(1);
    expect(child).toBeInstanceOf(ProjectStore);
    expect(child.projectId).toBe(1);
  });

  test("getStore returns the same instance on subsequent calls", () => {
    const a = store.getStore(1);
    const b = store.getStore(1);
    expect(a).toBe(b);
  });

  test("getStore creates separate instances for different projects", () => {
    const a = store.getStore(1);
    const b = store.getStore(2);
    expect(a).not.toBe(b);
    expect(a.projectId).toBe(1);
    expect(b.projectId).toBe(2);
  });

  // ---- peekStore ------------------------------------------------------------

  test("peekStore returns undefined before getStore", () => {
    expect(store.peekStore(1)).toBeUndefined();
  });

  test("peekStore returns the store after getStore", () => {
    const child = store.getStore(1);
    expect(store.peekStore(1)).toBe(child);
  });

  // ---- ensureLoaded ---------------------------------------------------------

  test("ensureLoaded creates store and fetches if not loaded", async () => {
    mockFetch(() => jsonResponse([]));

    await store.ensureLoaded(1);

    const child = store.peekStore(1);
    expect(child).toBeDefined();
    expect(child!.loaded).toBe(true);
  });

  test("ensureLoaded does not re-fetch if already loaded", async () => {
    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return jsonResponse([]);
    });

    await store.ensureLoaded(1);
    const countAfterFirst = fetchCount;

    await store.ensureLoaded(1);
    // fetch is called twice per fetchLists (tasks + sessions), so no new calls
    expect(fetchCount).toBe(countAfterFirst);
  });

  test("ensureLoaded does not re-fetch if currently loading", async () => {
    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return jsonResponse([]);
    });

    // Start two ensureLoaded calls concurrently
    const p1 = store.ensureLoaded(1);
    const p2 = store.ensureLoaded(1);
    await Promise.all([p1, p2]);

    // Only one fetchLists call (3 fetches: tasks + sessions + skills)
    expect(fetchCount).toBe(3);
  });

  // ---- refresh --------------------------------------------------------------

  test("refresh re-fetches if store exists", async () => {
    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return jsonResponse([]);
    });

    // Create and load first
    await store.ensureLoaded(1);
    const countAfterLoad = fetchCount;

    // Now refresh
    await store.refresh(1);
    expect(fetchCount).toBeGreaterThan(countAfterLoad);
  });

  test("refresh is a no-op if store does not exist", async () => {
    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return jsonResponse([]);
    });

    await store.refresh(99);
    expect(fetchCount).toBe(0);
  });

  // ---- refreshAll -----------------------------------------------------------

  test("refreshAll re-fetches all loaded stores", async () => {
    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return jsonResponse([]);
    });

    // Load two stores
    await store.ensureLoaded(1);
    await store.ensureLoaded(2);
    const countAfterLoad = fetchCount;

    // Also create a third store but don't load it
    store.getStore(3);

    await store.refreshAll();
    // Should have fetched for stores 1 and 2 (3 fetches each: tasks + sessions + skills)
    // but NOT for store 3 (not loaded)
    expect(fetchCount).toBe(countAfterLoad + 6);
  });

  test("refreshAll is a no-op when no stores are loaded", async () => {
    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return jsonResponse([]);
    });

    // Create but don't load
    store.getStore(1);

    await store.refreshAll();
    expect(fetchCount).toBe(0);
  });

  // ---- remove ---------------------------------------------------------------

  test("remove deletes the store from the map", () => {
    store.getStore(1);
    expect(store.peekStore(1)).toBeDefined();

    store.remove(1);
    expect(store.peekStore(1)).toBeUndefined();
  });

  test("remove notifies subscribers", () => {
    store.getStore(1);
    let notified = false;
    store.subscribe(() => { notified = true; });

    store.remove(1);
    expect(notified).toBe(true);
  });

  test("remove is a no-op if store does not exist", () => {
    let notified = false;
    store.subscribe(() => { notified = true; });

    store.remove(99);
    // Should not notify for non-existent stores
    expect(notified).toBe(false);
  });

  test("remove unsubscribes from child store notifications", async () => {
    mockFetch(() => jsonResponse([]));

    const child = store.getStore(1);
    let parentNotifyCount = 0;
    store.subscribe(() => { parentNotifyCount++; });

    // Trigger a child notification to confirm bubbling works
    await child.fetchLists();
    const countBefore = parentNotifyCount;

    // Remove and then trigger child notification
    store.remove(1);
    const countAfterRemove = parentNotifyCount;
    // remove itself notifies once
    expect(countAfterRemove).toBe(countBefore + 1);

    // Now triggering child should NOT bubble
    await child.fetchLists();
    expect(parentNotifyCount).toBe(countAfterRemove);
  });

  // ---- Notification bubbling ------------------------------------------------

  test("child store notifications bubble to projects store subscribers", async () => {
    mockFetch(() => jsonResponse([]));

    const child = store.getStore(1);
    let notifyCount = 0;
    store.subscribe(() => { notifyCount++; });

    await child.fetchLists();
    // fetchLists notifies twice (loading=true, loading=false)
    expect(notifyCount).toBe(2);
  });

  test("notifications from different children all bubble", async () => {
    mockFetch(() => jsonResponse([]));

    const child1 = store.getStore(1);
    const child2 = store.getStore(2);
    let notifyCount = 0;
    store.subscribe(() => { notifyCount++; });

    await child1.fetchLists();
    const countAfterFirst = notifyCount;

    await child2.fetchLists();
    expect(notifyCount).toBeGreaterThan(countAfterFirst);
  });

  // ---- subscribe/unsubscribe ------------------------------------------------

  test("subscribe returns an unsubscribe function", async () => {
    mockFetch(() => jsonResponse([]));

    const child = store.getStore(1);
    let count = 0;
    const unsub = store.subscribe(() => { count++; });

    await child.fetchLists();
    const countBefore = count;

    unsub();
    await child.fetchLists();
    expect(count).toBe(countBefore);
  });

  test("activityForSession reads activity from the target project store", () => {
    store.getStore(1).markSessionRunning("s1");
    store.getStore(2).markSessionRunning("s2");
    store.getStore(2).markSessionFinished("s2");

    expect(store.activityForSession(1, "s1")).toBe("running");
    expect(store.activityForSession(2, "s2")).toBe("finished");
    expect(store.activityForSession(1, "s2")).toBeUndefined();
    expect(store.activityForSession(99, "s1")).toBeUndefined();
  });

  test("activityForProject resolves project header activity", () => {
    store.getStore(1).markSessionRunning("s1");
    store.getStore(1).markSessionRunning("s2");
    store.getStore(1).markSessionFinished("s2");
    store.getStore(2).markSessionRunning("s3");

    expect(store.activityForProject(1)).toBe("running");
    expect(store.activityForProject(2)).toBe("running");
    expect(store.activityForProject(99)).toBeUndefined();
  });

  test("activitySummary aggregates across project stores", () => {
    store.getStore(1).markSessionRunning("s1");
    store.getStore(1).markSessionRunning("s2");
    store.getStore(1).markSessionFinished("s2");
    store.getStore(2).markSessionRunning("s3");

    expect(store.activitySummary).toEqual({ running: 2, finished: 1 });
  });

  test("handleAgentEnd marks activity and schedules project refresh reconciliation", async () => {
    const refresh = mock(async () => {});
    const clearActivityForClosedTasks = mock(() => {});
    store.refresh = refresh;
    store.clearActivityForClosedTasks = clearActivityForClosedTasks;

    store.handleAgentStart(42, "s1");
    store.handleAgentEnd(42, "s1", { suppressUnread: false });

    expect(store.activityForSession(42, "s1")).toBe("finished");

    await new Promise((resolve) => setTimeout(resolve, 510));

    expect(refresh).toHaveBeenCalledWith(42);
    expect(clearActivityForClosedTasks).toHaveBeenCalledWith(42);
  });

  test("handleTaskUpdated refreshes existing event-created stores and clears closed activity", async () => {
    store.getStore(42).markSessionRunning("s1");

    mockFetch((url) => {
      if (url === "/api/projects/42/tasks") {
        return jsonResponse([task({ status: "closed", session_ids: ["s1"] })]);
      }
      if (url === "/api/projects/42/sessions") return jsonResponse([]);
      if (url === "/api/projects/42/skills") return jsonResponse({ skills: [] });
      return jsonResponse({}, false);
    });

    await store.handleTaskUpdated(42);

    expect(store.getStore(42).loaded).toBe(true);
    expect(store.getStore(42).activityForSession("s1")).toBeUndefined();
  });

  test("handleTaskUpdated is a no-op if the project store does not exist", async () => {
    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return jsonResponse([]);
    });

    await store.handleTaskUpdated(99);

    expect(fetchCount).toBe(0);
    expect(store.peekStore(99)).toBeUndefined();
  });
});
