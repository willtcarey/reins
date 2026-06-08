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

  test("activityForSession reads from shared ActivityStore (works for all projects)", () => {
    store.setRunning("s1", 1);
    store.setRunning("s2", 2);
    store.setFinished("s2", 2);

    expect(store.activityForSession(1, "s1")).toBe("running");
    expect(store.activityForSession(2, "s2")).toBe("finished");
    // Activity is globally visible — projectId is just for the session→project mapping
    expect(store.activityForSession(1, "s2")).toBe("finished");
    // Works even for unloaded projects
    expect(store.activityForSession(99, "s1")).toBe("running");
  });

  test("activityForProject resolves project header activity via WS events", () => {
    store.handleAgentStart(1, "s1");
    store.handleAgentStart(1, "s2");
    store.handleAgentEnd(1, "s2");
    store.handleAgentStart(2, "s3");

    expect(store.activityForProject(1)).toBe("running");
    expect(store.activityForProject(2)).toBe("running");
    expect(store.activityForProject(99)).toBeUndefined();
  });

  test("activitySummary aggregates across project stores", () => {
    store.setRunning("s1", 1);
    store.setRunning("s2", 1);
    store.setFinished("s2", 1);
    store.setRunning("s3", 2);

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

  test("handleReconnect refreshes loaded data and clears closed activity", async () => {
    const calls: string[] = [];
    store.refreshAll = mock(async () => { calls.push("refreshAll"); });
    store.clearActivityForClosedTasks = mock(() => { calls.push("clearActivityForClosedTasks"); });

    await store.handleReconnect("active");

    expect(calls).toEqual([
      "refreshAll",
      "clearActivityForClosedTasks",
    ]);
  });

  test("handleTaskUpdated refreshes existing event-created stores and clears closed activity", async () => {
    store.setRunning("s1", 42);

    mockFetch((url) => {
      if (url === "/api/projects/42/tasks") {
        return jsonResponse([task({ status: "closed", session_ids: ["s1"] })]);
      }
      if (url === "/api/projects/42/sessions") return jsonResponse([]);
      if (url === "/api/projects/42/skills") return jsonResponse({ skills: [] });
      return jsonResponse({}, false);
    });

    // handleTaskUpdated only acts if the store already exists — create it
    store.getStore(42);
    await store.handleTaskUpdated(42);

    expect(store.getStore(42).loaded).toBe(true);
    expect(store.activityForSession(42, "s1")).toBeUndefined();
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
      if (url === "/api/activity") {
        return jsonResponse([
          { id: "s1", activity_state: "running", project_id: 1 },
          { id: "s2", activity_state: "finished", project_id: 2 },
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();

    // Stores should NOT be created — only lightweight tracker populated
    expect(store.peekStore(1)).toBeUndefined();
    expect(store.peekStore(2)).toBeUndefined();
    // But activityForProject should still return the right state
    expect(store.activityForProject(1)).toBe("running");
    expect(store.activityForProject(2)).toBe("finished");
  });

  test("fetchActivitySnapshot running wins over finished", async () => {
    mockFetch((url) => {
      if (url === "/api/activity") {
        return jsonResponse([
          { id: "s1", activity_state: "finished", project_id: 1 },
          { id: "s2", activity_state: "running", project_id: 1 },
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();

    // Project 1 has both running and finished sessions — running wins
    expect(store.activityForProject(1)).toBe("running");
  });

  test("fetchActivitySnapshot is a no-op for empty snapshot", async () => {
    mockFetch((url) => {
      if (url === "/api/activity") {
        return jsonResponse([]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();

    expect(store.activityForProject(1)).toBeUndefined();
  });

  test("fetchActivitySnapshot handles fetch failure gracefully", async () => {
    mockFetch(() => { throw new Error("network"); });

    // Should not throw
    await store.fetchActivitySnapshot();

    expect(store.activityForProject(1)).toBeUndefined();
  });

  test("activityForProject reflects WS event updates via handleAgentStart", async () => {
    // Snapshot says project 1 is finished
    mockFetch((url) => {
      if (url === "/api/activity") {
        return jsonResponse([
          { id: "s1", activity_state: "finished", project_id: 1 },
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();
    expect(store.activityForProject(1)).toBe("finished");

    // WS event promotes to running
    restoreFetch();
    mockFetch(() => jsonResponse([]));
    store.handleAgentStart(1, "s2");

    expect(store.activityForProject(1)).toBe("running");
  });

  test("activityForProject reflects WS event updates via handleAgentEnd", async () => {
    mockFetch((url) => {
      if (url === "/api/activity") {
        return jsonResponse([
          { id: "s1", activity_state: "running", project_id: 1 },
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();
    expect(store.activityForProject(1)).toBe("running");

    // WS event demotes to finished
    restoreFetch();
    mockFetch(() => jsonResponse([]));
    store.handleAgentEnd(1, "s1");

    expect(store.activityForProject(1)).toBe("finished");
  });

  test("activitySummary includes unloaded projects from snapshot", async () => {
    mockFetch((url) => {
      if (url === "/api/activity") {
        return jsonResponse([
          { id: "s1", activity_state: "running", project_id: 1 },
          { id: "s2", activity_state: "finished", project_id: 2 },
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
      if (url === "/api/activity") {
        return jsonResponse([
          { id: "s1", activity_state: "running", project_id: 1 },
        ]);
      }
      return jsonResponse({}, false);
    });

    await store.fetchActivitySnapshot();

    // Load the store — the loaded store's activitySummary also sees the running session
    restoreFetch();
    mockFetch(() => jsonResponse([]));
    await store.ensureLoaded(1);
    store.setRunning("s1", 1);

    // Should count once, not twice
    expect(store.activitySummary).toEqual({ running: 1, finished: 0 });
  });

  // ---- setRunning / setFinished with closed-task guard ----------------------

  test("setRunning applies closed-task guard when store is loaded", async () => {
    // Load the store with a closed task
    mockFetch((url) => {
      if (url === "/api/projects/42/tasks") {
        return jsonResponse([task({ status: "closed", session_ids: ["s1"] })]);
      }
      if (url === "/api/projects/42/sessions") return jsonResponse([]);
      if (url === "/api/projects/42/skills") return jsonResponse({ skills: [] });
      return jsonResponse({}, false);
    });

    await store.ensureLoaded(42);

    // Attempt to set running for a closed-task session — should be suppressed
    store.setRunning("s1", 42);
    expect(store.activityForSession(42, "s1")).toBeUndefined();
  });

  test("setRunning works without guard when store is not loaded", () => {
    // No store loaded for project 99
    store.setRunning("s99", 99);
    expect(store.activityForSession(99, "s99")).toBe("running");
    // And no store was created
    expect(store.peekStore(99)).toBeUndefined();
  });

  test("setFinished applies closed-task guard when store is loaded", async () => {
    mockFetch((url) => {
      if (url === "/api/projects/42/tasks") {
        return jsonResponse([task({ status: "closed", session_ids: ["s1"] })]);
      }
      if (url === "/api/projects/42/sessions") return jsonResponse([]);
      if (url === "/api/projects/42/skills") return jsonResponse({ skills: [] });
      return jsonResponse({}, false);
    });

    await store.ensureLoaded(42);

    store.setFinished("s1", 42);
    expect(store.activityForSession(42, "s1")).toBeUndefined();
  });

  test("setFinished works without guard when store is not loaded", () => {
    store.setFinished("s99", 99);
    expect(store.activityForSession(99, "s99")).toBe("finished");
  });

  // ---- markSessionViewed (moved from ProjectStore) --------------------------

  test("markSessionViewed clears finished activity optimistically", async () => {
    store.setRunning("s1", 1);
    store.setFinished("s1", 1);

    mockFetch(() => jsonResponse({ ok: true }));

    // Start the request but don't await — local state should already be updated
    const promise = store.markSessionViewed(1, "s1");
    expect(store.activityForSession(1, "s1")).toBeUndefined();

    await promise;
    expect(store.activityForSession(1, "s1")).toBeUndefined();
  });

  test("markSessionViewed rolls back to finished if the server request fails", async () => {
    store.setRunning("s1", 1);
    store.setFinished("s1", 1);

    mockFetch(() => new Response("fail", { status: 500 }));

    await store.markSessionViewed(1, "s1");

    // Should be restored to finished so reconnect reconciles
    expect(store.activityForSession(1, "s1")).toBe("finished");
  });

  test("markSessionViewed rolls back on network error", async () => {
    store.setRunning("s1", 1);
    store.setFinished("s1", 1);

    mockFetch(() => { throw new Error("network"); });

    await store.markSessionViewed(1, "s1");

    expect(store.activityForSession(1, "s1")).toBe("finished");
  });

  test("markSessionViewed is a no-op when activity is not finished", async () => {
    store.setRunning("s1", 1);

    mockFetch(() => jsonResponse({ ok: true }));

    await store.markSessionViewed(1, "s1");

    // Running activity stays — only finished gets cleared
    expect(store.activityForSession(1, "s1")).toBe("running");
  });

  test("markSessionViewed works for unloaded projects", async () => {
    store.setFinished("s99", 99);

    mockFetch(() => jsonResponse({ ok: true }));

    await store.markSessionViewed(99, "s99");

    expect(store.activityForSession(99, "s99")).toBeUndefined();
  });

  // ---- trackDelegateSession (moved from ProjectStore) -----------------------

  test("trackDelegateSession suppresses activity on completion", () => {
    store.trackDelegateSession("delegate-1");
    store.setRunning("delegate-1", 1);
    store.setFinished("delegate-1", 1);

    expect(store.activityForSession(1, "delegate-1")).toBeUndefined();
  });

  // ---- clearActivityForClosedTasks (consolidated) --------------------------

  test("clearActivityForClosedTasks clears for specific project", async () => {
    mockFetch((url) => {
      if (url === "/api/projects/42/tasks") {
        return jsonResponse([task({ status: "closed", session_ids: ["s1"] })]);
      }
      if (url === "/api/projects/42/sessions") return jsonResponse([]);
      if (url === "/api/projects/42/skills") return jsonResponse({ skills: [] });
      return jsonResponse({}, false);
    });

    await store.ensureLoaded(42);
    store.setRunning("s1", 42);
    // s1 was set running but the ensureLoaded already cleared it via the guard
    // Let's set it again to verify clearActivityForClosedTasks works
    store.activityStore.setRunning("s1");
    expect(store.activityForSession(42, "s1")).toBe("running");

    store.clearActivityForClosedTasks(42);
    expect(store.activityForSession(42, "s1")).toBeUndefined();
  });

  test("clearActivityForClosedTasks clears for all projects when no projectId given", async () => {
    mockFetch((url) => {
      if (url === "/api/projects/1/tasks") return jsonResponse([task({ id: 1, project_id: 1, status: "closed", session_ids: ["s1"] })]);
      if (url === "/api/projects/2/tasks") return jsonResponse([task({ id: 1, project_id: 2, status: "closed", session_ids: ["s2"] })]);
      if (url.includes("/sessions")) return jsonResponse([]);
      if (url.includes("/skills")) return jsonResponse({ skills: [] });
      return jsonResponse({}, false);
    });

    await store.ensureLoaded(1);
    await store.ensureLoaded(2);

    store.activityStore.setRunning("s1");
    store.activityStore.setRunning("s2");

    store.clearActivityForClosedTasks();

    expect(store.activityForSession(1, "s1")).toBeUndefined();
    expect(store.activityForSession(2, "s2")).toBeUndefined();
  });

  // ---- handleAgentStart / handleAgentEnd use setRunning / setFinished -------

  test("handleAgentStart delegates to setRunning", () => {
    store.handleAgentStart(1, "s1");
    expect(store.activityForProject(1)).toBe("running");
    // Does NOT create a ProjectStore
    expect(store.peekStore(1)).toBeUndefined();
  });

  test("handleAgentEnd delegates to setFinished", async () => {
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
});
