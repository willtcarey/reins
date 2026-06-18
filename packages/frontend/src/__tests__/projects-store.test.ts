/**
 * Tests for ProjectsStore — project list, CRUD, and per-project data stores.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { ProjectsStore } from "../models/stores/projects-store.js";
import { ProjectStore } from "../models/stores/project-store.js";
import { SessionCache } from "../models/stores/session-cache.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";

// Mock fetch globally

function jsonResponse(data: unknown, ok = true): Response {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ProjectsStore per-project data", () => {
  let store: ProjectsStore;
  let sessionCache: SessionCache;

  beforeEach(() => {
    sessionCache = new SessionCache();
    store = new ProjectsStore(sessionCache);
    restoreFetch();
  });

  function setActivity(sessionId: string, projectId: number, activityState: "running" | "finished" | null): void {
    sessionCache.set(sessionId, { projectId, activityState });
  }

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

  test("remove notifies even if store does not exist", () => {
    let notified = false;
    store.subscribe(() => { notified = true; });

    store.remove(99);
    expect(notified).toBe(true);
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

  test("remove clears shared activity for the removed loaded project", () => {
    store.getStore(1);
    setActivity("p1-running", 1, "running");
    setActivity("p1-finished", 1, "finished");
    setActivity("p2-running", 2, "running");

    store.remove(1);

    expect(store.activityForSession(1, "p1-running")).toBeNull();
    expect(store.activityForSession(1, "p1-finished")).toBeNull();
    expect(store.activityForProject(1)).toBeNull();
    expect(store.activityForProject(2)).toBe("running");
    expect(store.activitySummary).toEqual({ running: 1, finished: 0 });
  });

  test("remove clears shared activity for snapshot-only unloaded projects", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/activity") {
        return jsonResponse([
          { id: "p1-running", activityState: "running", projectId: 1, taskId: null },
          { id: "p2-finished", activityState: "finished", projectId: 2, taskId: null },
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();
    expect(store.peekStore(1)).toBeUndefined();

    store.remove(1);

    expect(store.activityForSession(1, "p1-running")).toBeNull();
    expect(store.activityForProject(1)).toBeNull();
    expect(store.activityForProject(2)).toBe("finished");
    expect(store.activitySummary).toEqual({ running: 0, finished: 1 });
  });

  test("remove drops cached sessions for the removed project", () => {
    const cache = new SessionCache();
    store = new ProjectsStore(cache);
    cache.set("p1-session", { projectId: 1, activityState: "finished" });
    cache.set("p2-session", { projectId: 2, activityState: "running" });

    store.remove(1);

    expect(cache.get("p1-session")).toBeUndefined();
    expect(cache.get("p2-session")?.projectId).toBe(2);
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

  test("activityForSession reads from SessionCache (works for all projects)", () => {
    setActivity("s1", 1, "running");
    setActivity("s2", 2, "running");
    setActivity("s2", 2, "finished");

    expect(store.activityForSession(1, "s1")).toBe("running");
    expect(store.activityForSession(2, "s2")).toBe("finished");
    // Activity is globally visible — projectId is just for the session→project mapping
    expect(store.activityForSession(1, "s2")).toBe("finished");
    // Works even for unloaded projects
    expect(store.activityForSession(99, "s1")).toBe("running");
  });

  test("activityForProject resolves project header activity from SessionCache", () => {
    setActivity("s1", 1, "running");
    setActivity("s2", 1, "finished");
    setActivity("s3", 2, "running");

    expect(store.activityForProject(1)).toBe("running");
    expect(store.activityForProject(2)).toBe("running");
    expect(store.activityForProject(99)).toBeNull();
  });

  test("activitySummary aggregates across project stores", () => {
    setActivity("s1", 1, "running");
    setActivity("s2", 1, "running");
    setActivity("s2", 1, "finished");
    setActivity("s3", 2, "running");

    expect(store.activitySummary).toEqual({ running: 2, finished: 1 });
  });

  test("handleReconnect refreshes loaded data", async () => {
    const refreshAll = mock(async () => {});
    store.refreshAll = refreshAll;

    await store.handleReconnect("active");

    expect(refreshAll).toHaveBeenCalled();
  });

  test("handleTaskUpdated refreshes existing event-created stores", async () => {
    mockFetch((url) => {
      if (url === "/api/projects/42/tasks") return jsonResponse([]);
      if (url === "/api/projects/42/sessions") return jsonResponse([]);
      if (url === "/api/projects/42/skills") return jsonResponse({ skills: [] });
      return jsonResponse({}, false);
    });

    // handleTaskUpdated only fetches lists if the store already exists — create it
    store.getStore(42);
    await store.handleTaskUpdated(42);

    expect(store.getStore(42).loaded).toBe(true);
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

  test("fetchActivitySnapshot populates activity without creating stores", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/activity") {
        return jsonResponse([
          { id: "s1", activityState: "running", projectId: 1, taskId: 7 },
          { id: "s2", activityState: "finished", projectId: 2, taskId: null },
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();

    // Stores should NOT be created — only lightweight tracker populated
    expect(store.peekStore(1)).toBeUndefined();
    expect(store.peekStore(2)).toBeUndefined();
    // But activityForProject should still return the right state, and task metadata is cached.
    expect(store.activityForProject(1)).toBe("running");
    expect(sessionCache.get("s1")?.taskId).toBe(7);
    expect(store.activityForProject(2)).toBe("finished");
  });

  test("fetchActivitySnapshot running wins over finished", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/activity") {
        return jsonResponse([
          { id: "s1", activityState: "finished", projectId: 1, taskId: null },
          { id: "s2", activityState: "running", projectId: 1, taskId: null },
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();

    // Project 1 has both running and finished sessions — running wins
    expect(store.activityForProject(1)).toBe("running");
  });

  test("fetchActivitySnapshot clears local activity absent from authoritative snapshot", async () => {
    setActivity("stale-running", 1, "running");
    setActivity("stale-finished", 2, "finished");
    setActivity("kept-finished", 3, "finished");

    mockFetch((url) => {
      if (url === "/api/sessions/activity") {
        return jsonResponse([
          { id: "kept-finished", activityState: "finished", projectId: 3, taskId: null },
          { id: "new-running", activityState: "running", projectId: 4, taskId: null },
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();

    expect(store.activityForSession(1, "stale-running")).toBeNull();
    expect(store.activityForSession(2, "stale-finished")).toBeNull();
    expect(store.activityForProject(1)).toBeNull();
    expect(store.activityForProject(2)).toBeNull();
    expect(store.activityForProject(3)).toBe("finished");
    expect(store.activityForProject(4)).toBe("running");
    expect(store.activitySummary).toEqual({ running: 1, finished: 1 });
  });

  test("fetchActivitySnapshot is a no-op for empty snapshot", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/activity") {
        return jsonResponse([]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();

    expect(store.activityForProject(1)).toBeNull();
  });

  test("fetchActivitySnapshot handles fetch failure gracefully", async () => {
    mockFetch(() => { throw new Error("network"); });

    // Should not throw
    await store.fetchActivitySnapshot();

    expect(store.activityForProject(1)).toBeNull();
  });

  test("activitySummary includes unloaded projects from snapshot", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/activity") {
        return jsonResponse([
          { id: "s1", activityState: "running", projectId: 1, taskId: null },
          { id: "s2", activityState: "finished", projectId: 2, taskId: null },
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();

    // No stores loaded, but summary should still count
    expect(store.activitySummary).toEqual({ running: 1, finished: 1 });
  });

  test("activitySummary does not double-count loaded projects", async () => {
    // Snapshot says project 1 has a running session
    mockFetch((url) => {
      if (url === "/api/sessions/activity") {
        return jsonResponse([
          { id: "s1", activityState: "running", projectId: 1, taskId: null },
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();

    // Load the store — the loaded store's activitySummary also sees the running session
    restoreFetch();
    mockFetch(() => jsonResponse([]));
    await store.ensureLoaded(1);
    setActivity("s1", 1, "running");

    // Should count once, not twice
    expect(store.activitySummary).toEqual({ running: 1, finished: 0 });
  });

});
