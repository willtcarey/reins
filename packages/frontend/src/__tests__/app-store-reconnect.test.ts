/**
 * Tests for AppStore reconnect catch-up behavior.
 *
 * On WS reconnect (connection=true), the store should:
 *  - Re-fetch the project list
 *  - Delegate project-domain reconnect catch-up
 *  - Re-fetch the active session's messages if one is being viewed
 */
import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { AppStore } from "../models/stores/app-store.js";
import { StubClient } from "./helpers/stub-client.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";

function sessionDetail(isStreaming: boolean) {
  return {
    id: "sess-1",
    projectId: 42,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: isStreaming ? 1 : 2,
    activityState: isStreaming ? "running" as const : "finished" as const,
    state: {
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      thinkingLevel: "high",
      isStreaming,
      messageCount: isStreaming ? 1 : 2,
    },
  };
}

describe("AppStore reconnect catch-up", () => {
  let client: StubClient;
  let store: AppStore;

  beforeEach(() => {
    client = new StubClient();
    store = new AppStore(client);
    restoreFetch();
  });

  afterEach(() => {
    store.dispose();
    restoreFetch();
  });

  test("reconnect fetches projects and delegates project reconnect catch-up", () => {
    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.handleReconnect = mock(async () => {});

    client.fireConnection(true);

    expect(store.projectsStore.fetchProjects).toHaveBeenCalled();
    // handleReconnect is called with activeSessionId (null when no active session)
    expect(store.projectsStore.handleReconnect).toHaveBeenCalled();
  });

  test("reconnect refreshes active session messages", async () => {
    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.handleReconnect = mock(async () => {});

    // Set up an active session
    const activeStore = store.activeSessionStore;
    activeStore.sessionId = "sess-1";
    store.sessionCache.set("sess-1", {
      projectId: 42,
      taskId: null,
      parentSessionId: null,
      name: null,
      createdAt: "",
      updatedAt: "",
      messageCount: 0,
      activityState: null,
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "high",
        isStreaming: false,
        messageCount: 2,
      },
    });

    const refreshMessagesSpy = mock(async () => {});
    activeStore.refreshMessages = refreshMessagesSpy;
    activeStore.refreshSession = mock(async () => {});

    client.fireConnection(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(store.projectsStore.handleReconnect).toHaveBeenCalledWith("sess-1");
    expect(refreshMessagesSpy).toHaveBeenCalled();
  });

  test("reconnect does not call handleReconnect when disconnecting", () => {
    const handleReconnectSpy = mock(async () => {});
    store.projectsStore.handleReconnect = handleReconnectSpy;

    client.fireConnection(false);

    expect(handleReconnectSpy).not.toHaveBeenCalled();
  });

  test("connect fetches activity snapshot and populates project-level activity", async () => {
    const snapshot = [
      { id: "s1", activityState: "running" as const, projectId: 10, taskId: null },
      { id: "s2", activityState: "finished" as const, projectId: 20, taskId: null },
    ];

    mockFetch((url) => {
      if (url === "/api/sessions/activity") {
        return new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/projects") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("", { status: 404 });
    });

    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.handleReconnect = mock(async () => {});

    client.fireConnection(true);

    // Wait for the async fetch to settle
    await new Promise((r) => setTimeout(r, 0));

    // Snapshot does NOT create stores — only lightweight activity tracker
    expect(store.projectsStore.peekStore(10)).toBeUndefined();
    expect(store.projectsStore.peekStore(20)).toBeUndefined();
    // But project-level activity is available
    expect(store.projectsStore.activityForProject(10)).toBe("running");
    expect(store.projectsStore.activityForProject(20)).toBe("finished");
  });

  test("connect does not crash when activity endpoint returns empty", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/activity") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("", { status: 404 });
    });

    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.handleReconnect = mock(async () => {});

    // Should not throw
    client.fireConnection(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(store.projectsStore.activitySummary).toEqual({ running: 0, finished: 0 });
  });

  test("reconnect marks a visible active session viewed when reconciliation finds it finished", async () => {
    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.handleReconnect = mock(async () => {});

    let isStreaming = true;
    const requests: Array<{ url: string; method: string }> = [];
    mockFetch((url, init) => {
      requests.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/sessions/activity") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/sessions/sess-1") {
        return new Response(JSON.stringify(sessionDetail(isStreaming)), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/sessions/sess-1/messages") {
        return new Response(JSON.stringify([
          { role: "user", content: "hello", timestamp: 1000 },
          { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2000 },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/sessions/sess-1/activity" && init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("", { status: 404 });
    });

    await store.setRoute("sess-1");
    isStreaming = false;

    client.fireConnection(true);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(requests).toContainEqual({ url: "/api/sessions/sess-1/activity", method: "PATCH" });
    expect(store.projectsStore.activityForSession(42, "sess-1")).toBeNull();
  });

  test("browser resume reconciles a missed agent_end without waiting for websocket reconnect", async () => {
    store.dispose();

    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const fakeWindow = new EventTarget();
    const fakeDocument = new EventTarget();
    Object.defineProperty(fakeDocument, "visibilityState", { value: "visible", configurable: true });
    Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: fakeDocument, configurable: true });

    try {
      client = new StubClient();
      store = new AppStore(client);
      store.connect();
      store.projectsStore.handleReconnect = mock(async () => {});

      let isStreaming = true;
      mockFetch((url) => {
        if (url === "/api/projects" || url === "/api/sessions/activity") {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url === "/api/sessions/sess-1") {
          return new Response(JSON.stringify(sessionDetail(isStreaming)), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url === "/api/sessions/sess-1/messages") {
          return new Response(JSON.stringify([
            { role: "user", content: "hello", timestamp: 1000 },
            { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2000 },
          ]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("", { status: 404 });
      });

      await store.setRoute("sess-1");
      isStreaming = false;

      fakeWindow.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(store.activeSessionStore.sessionData.state.isStreaming).toBe(false);
      expect(store.activeSessionStore.sessionMessages).toHaveLength(2);
    } finally {
      store.dispose();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
});
