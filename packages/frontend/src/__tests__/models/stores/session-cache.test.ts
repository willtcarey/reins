import { afterEach, describe, expect, test } from "bun:test";
import { SessionCache } from "../../../models/stores/session-cache.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import type { SessionData, SessionListItem } from "../../../models/ws-client.js";

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

function sessionDetail(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: "sess-1",
    projectId: 42,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    runtimeType: "pi",
    activityState: null,
    messageCount: 0,
    state: {
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      thinkingLevel: "high",
    },
    ...overrides,
  };
}

function listItem(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "sess-1",
    projectId: 42,
    taskId: null,
    parentSessionId: null,
    name: "Session 1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    messageCount: 2,
    firstMessage: "hello",
    activityState: "running",
    ...overrides,
  };
}

describe("SessionCache", () => {
  afterEach(() => { restoreFetch(); });

  test("merges session data by session id", () => {
    const store = new SessionCache();

    const listSession = listItem();
    store.set(listSession.id, listSession);
    expect(store.get("sess-1")?.projectId).toBe(42);
    expect(store.get("sess-1")?.firstMessage).toBe("hello");
    expect(store.get("sess-1")?.messageCount).toBe(2);
    expect(store.get("sess-1")?.activityState).toBe("running");

    const detailSession = sessionDetail({ activityState: "finished" });
    store.set(detailSession.id, detailSession);
    expect(store.get("sess-1")?.messageCount).toBe(0);
    expect(store.get("sess-1")?.activityState).toBe("finished");
    expect(store.get("sess-1")?.firstMessage).toBe("hello");
  });

  test("set can apply partial activity updates", () => {
    const store = new SessionCache();
    store.set("sess-1", sessionDetail());

    store.set("sess-1", { activityState: "running" });

    expect(store.get("sess-1")?.activityState).toBe("running");
    expect(store.get("sess-1")?.state?.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-20250514" });
  });

  test("setMany merges multiple session records", () => {
    const store = new SessionCache();

    store.setMany([
      listItem({ id: "sess-1", firstMessage: "one" }),
      listItem({ id: "sess-2", firstMessage: "two" }),
    ]);

    expect(store.get("sess-1")?.firstMessage).toBe("one");
    expect(store.get("sess-2")?.firstMessage).toBe("two");
  });

  test("returns complete session detail from the cache", () => {
    const store = new SessionCache();
    const detail = sessionDetail({ runtimeType: undefined });

    store.set("sess-1", detail);

    expect(store.getDetail("sess-1")).toEqual(detail);
  });

  test("does not synthesize detail from partial cached records", () => {
    const store = new SessionCache();
    store.set("sess-1", listItem());

    expect(store.getDetail("sess-1")).toBeNull();
  });

  test("notifies listeners for the updated session", () => {
    const store = new SessionCache();
    const calls: string[] = [];

    const unsubscribe = store.subscribe("sess-1", () => calls.push("sess-1"));
    store.set("sess-1", sessionDetail());
    store.set("sess-2", sessionDetail({ id: "sess-2" }));
    unsubscribe();
    store.set("sess-1", sessionDetail({ name: "after unsubscribe" }));

    expect(calls).toEqual(["sess-1"]);
  });

  test("removeMany removes cached sessions by id", () => {
    const store = new SessionCache();
    const calls: string[] = [];
    store.subscribeAll((sessionId) => calls.push(sessionId));

    store.set("sess-1", listItem({ id: "sess-1", projectId: 42 }));
    store.set("sess-2", listItem({ id: "sess-2", projectId: 42 }));
    store.set("sess-3", listItem({ id: "sess-3", projectId: 99 }));

    const removed = store.removeMany(["sess-1", "sess-2", "missing"]);

    expect(removed).toEqual(["sess-1", "sess-2"]);
    expect(store.get("sess-1")).toBeUndefined();
    expect(store.get("sess-2")).toBeUndefined();
    expect(store.get("sess-3")?.projectId).toBe(99);
    expect(calls).toEqual(["sess-1", "sess-2", "sess-3", "sess-1", "sess-2"]);
  });

  test("dedupes concurrent detail fetches", async () => {
    const store = new SessionCache();
    let fetchCount = 0;

    mockFetch((url) => {
      expect(url).toBe("/api/sessions/sess-1");
      fetchCount++;
      return jsonResponse(sessionDetail({ messageCount: 5 }));
    });

    const [a, b] = await Promise.all([
      store.fetchDetail("sess-1"),
      store.fetchDetail("sess-1"),
    ]);

    expect(fetchCount).toBe(1);
    expect(a).toBe(b);
    expect(store.get("sess-1")?.messageCount).toBe(5);
  });
});
