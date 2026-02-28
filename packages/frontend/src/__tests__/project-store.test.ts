/**
 * Tests for ProjectStore — project list, CRUD, and per-project data stores.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { ProjectStore } from "../stores/project-store.js";
import { ProjectDataStore } from "../stores/project-data-store.js";

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

describe("ProjectStore per-project data", () => {
  let store: ProjectStore;

  beforeEach(() => {
    store = new ProjectStore();
    globalThis.fetch = originalFetch;
  });

  // ---- Lazy creation --------------------------------------------------------

  test("getStore creates a ProjectDataStore on first call", () => {
    const child = store.getStore(1);
    expect(child).toBeInstanceOf(ProjectDataStore);
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

    // Only one fetchLists call (2 fetches: tasks + sessions)
    expect(fetchCount).toBe(2);
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

  test("child store notifications bubble to project store subscribers", async () => {
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
});
