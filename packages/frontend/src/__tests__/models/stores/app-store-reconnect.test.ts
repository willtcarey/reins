/**
 * Tests for AppStore reconnect catch-up behavior.
 *
 * Across WS disconnect/reconnect, the store should:
 *  - Preserve received assistant snapshots and tool execution state
 *  - Re-fetch the project list
 *  - Delegate project-domain reconnect catch-up
 *  - Re-fetch the active session's messages if one is being viewed
 */
import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { AppStore } from "../../../models/stores/app-store.js";
import { WorkspaceStore } from "../../../models/stores/workspace-store.js";
import { StubClient } from "../../helpers/stub-client.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { messagePage } from "../../helpers/conversations.js";

function sessionDetail(isRunning: boolean, taskId: number | null = null) {
  return {
    id: "sess-1",
    projectId: 42,
    taskId,
    parentSessionId: null,
    name: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: isRunning ? 1 : 2,
    activityState: isRunning ? "running" as const : "finished" as const,
    state: {
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      thinkingLevel: "high",
      messageCount: isRunning ? 1 : 2,
    },
  };
}

describe("AppStore reconnect catch-up", () => {
  let client: StubClient;
  let store: AppStore;
  let workspace: WorkspaceStore;

  beforeEach(() => {
    client = new StubClient();
    store = new AppStore(client);
    workspace = new WorkspaceStore(store);
    restoreFetch();
  });

  afterEach(() => {
    workspace.dispose();
    store.dispose();
    restoreFetch();
  });

  test("reconnect refreshes project state", () => {
    store.projectsStore.refreshFromServer = mock(async () => {});

    client.fireConnection(true);

    expect(store.projectsStore.refreshFromServer).toHaveBeenCalled();
  });

  test("sets the code review scope from the viewed session", async () => {
    const setScope = mock(async () => {});
    workspace.codeReviewStore.setScope = setScope;
    mockFetch((url) => {
      if (url === "/api/sessions/sess-1") return Response.json(sessionDetail(false, 11));
      if (url === "/api/sessions/sess-1/messages") return Response.json(messagePage());
      return Response.json([]);
    });

    await workspace.setSession("sess-1");

    expect(setScope).toHaveBeenLastCalledWith({ projectId: 42, taskId: 11 });
  });

  test("applies scoped code review invalidations", () => {
    const handleUpdated = mock(async () => {});
    workspace.codeReviewStore.handleUpdated = handleUpdated;

    client.fireMessage({
      type: "code_review_updated",
      projectId: 7,
      taskId: 11,
      reviewId: "review-1",
      revision: 2,
    });

    expect(handleUpdated).toHaveBeenCalledWith({
      projectId: 7,
      taskId: 11,
      reviewId: "review-1",
      revision: 2,
    });
  });

  test("reconnect refreshes active session state", async () => {
    store.projectsStore.refreshFromServer = mock(async () => {});

    // Set up an active session
    mockFetch((url) => {
      if (url === "/api/sessions/sess-1") return Response.json(sessionDetail(false));
      if (url === "/api/sessions/sess-1/messages") return Response.json(messagePage());
      if (url === "/api/sessions/activity") return Response.json([]);
      if (url === "/api/projects") return Response.json([]);
      return new Response("", { status: 404 });
    });
    await workspace.setSession("sess-1");
    const activeStore = workspace.activeSessionStore;
    if (!activeStore) throw new Error("Expected active session store");
    const refreshFromServerSpy = mock(async () => {});
    activeStore.refreshFromServer = refreshFromServerSpy;

    client.fireConnection(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(store.projectsStore.refreshFromServer).toHaveBeenCalled();
    expect(refreshFromServerSpy).toHaveBeenCalled();
  });

  test("disconnect preserves received assistant snapshots", () => {
    const start = { role: "assistant" as const, content: [], timestamp: 100 };
    const message = {
      ...start,
      content: [{ type: "text" as const, text: "received" }],
    };
    client.fireMessage({ type: "event", sessionId: "sess-1", projectId: 42, event: { type: "agent_start" } });
    client.fireMessage({ type: "event", sessionId: "sess-1", projectId: 42, event: { type: "message_start", message: start } });
    client.fireMessage({
      type: "event",
      sessionId: "sess-1",
      projectId: 42,
      event: { type: "message_update", message, assistantMessageEvent: { type: "snapshot" } },
    });

    client.fireConnection(false);
    client.fireMessage({
      type: "event",
      sessionId: "sess-1",
      projectId: 42,
      event: {
        type: "tool_execution_start",
        toolCallId: "missed-owner",
        toolName: "read",
        args: {},
      },
    });

    expect(store.activeConversationsStore.get("sess-1").streamingMessages.map(({ raw }) => raw)).toEqual([message]);
  });

  test("reconnect does not refresh project state when disconnecting", () => {
    const refreshFromServerSpy = mock(async () => {});
    store.projectsStore.refreshFromServer = refreshFromServerSpy;

    client.fireConnection(false);

    expect(refreshFromServerSpy).not.toHaveBeenCalled();
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
    store.projectsStore.refreshAll = mock(async () => {});

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
    store.projectsStore.refreshAll = mock(async () => {});

    // Should not throw
    client.fireConnection(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(store.projectsStore.activitySummary).toEqual({ running: 0, finished: 0 });
  });

  test("reconnect prunes unobserved conversation state when no running activity remains", async () => {
    const start = { role: "assistant" as const, content: [], timestamp: 100 };
    const message = { ...start, content: [{ type: "text" as const, text: "working" }] };
    client.fireMessage({ type: "event", sessionId: "bg-session", projectId: 42, event: { type: "agent_start" } });
    client.fireMessage({ type: "event", sessionId: "bg-session", projectId: 42, event: { type: "message_start", message: start } });
    client.fireMessage({
      type: "event",
      sessionId: "bg-session",
      projectId: 42,
      event: { type: "message_update", message, assistantMessageEvent: { type: "snapshot" } },
    });
    expect(store.activeConversationsStore.get("bg-session").streamingMessages.map(({ raw }) => raw)).toEqual([message]);

    mockFetch((url) => {
      if (url === "/api/sessions/activity") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("", { status: 404 });
    });
    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.refreshAll = mock(async () => {});

    client.fireConnection(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(store.activeConversationsStore.get("bg-session")).toMatchObject({
      messages: [],
      streamingMessages: [],
      hasEarlierMessages: false,
    });
  });

  test("reconnect leaves finished activity unread for the conversation view to observe", async () => {
    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.refreshAll = mock(async () => {});

    let isRunning = true;
    const requests: Array<{ url: string; method: string }> = [];
    mockFetch((url, init) => {
      requests.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/sessions/activity") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/sessions/sess-1") {
        return new Response(JSON.stringify(sessionDetail(isRunning)), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/sessions/sess-1/messages") {
        return Response.json(messagePage([
          { role: "user", content: "hello", timestamp: 1000 },
          { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2000 },
        ]));
      }
      if (url === "/api/sessions/sess-1/activity" && init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("", { status: 404 });
    });

    await workspace.setSession("sess-1");
    isRunning = false;

    client.fireConnection(true);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(requests).not.toContainEqual({ url: "/api/sessions/sess-1/activity", method: "PATCH" });
    expect(store.projectsStore.activityForSession(42, "sess-1")).toBe("finished");
  });

  test("browser resume reconciles a missed agent_end without waiting for websocket reconnect", async () => {
    workspace.dispose();
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
      workspace = new WorkspaceStore(store);
      store.connect();
      store.projectsStore.refreshAll = mock(async () => {});

      let isRunning = true;
      mockFetch((url) => {
        if (url === "/api/projects" || url === "/api/sessions/activity") {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url === "/api/sessions/sess-1") {
          return new Response(JSON.stringify(sessionDetail(isRunning)), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url === "/api/sessions/sess-1/messages") {
          return Response.json(messagePage([
            { role: "user", content: "hello", timestamp: 1000 },
            { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2000 },
          ]));
        }
        return new Response("", { status: 404 });
      });

      await workspace.setSession("sess-1");
      isRunning = false;

      fakeWindow.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(workspace.activeSessionStore?.sessionData.activityState).toBe("finished");
      expect(workspace.activeSessionStore?.conversation.messages ?? []).toHaveLength(2);
    } finally {
      workspace.dispose();
      store.dispose();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
});
