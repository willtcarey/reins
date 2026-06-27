import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AppStore } from "../../../models/stores/app-store.js";
import { StubClient } from "../../helpers/stub-client.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

describe("AppStore activity event routing", () => {
  let client: StubClient;
  let store: AppStore;

  beforeEach(() => {
    client = new StubClient();
    store = new AppStore(client);
  });

  afterEach(() => {
    store.dispose();
    restoreFetch();
  });

  test("forwards shared settings store updates to app subscribers", async () => {
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    mockFetch((url, init) => {
      if (url === "/api/settings/diff_renderer" && init?.method === "PUT") {
        return Response.json({ ok: true });
      }
      return Response.json({}, { status: 404 });
    });

    const result = await store.settingsStore.selectDiffRenderer("virtual");

    unsubscribe();
    expect(result).toEqual({ ok: true });
    expect(store.settingsStore.diffRenderer).toBe("virtual");
    expect(notifications).toBeGreaterThan(0);
  });

  test("raw agent events update conversation cache but do not mutate project activity", () => {
    client.fireEvent("s1", 42, { type: "agent_start" });
    client.fireEvent("s1", 42, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "working" },
    });

    expect(store.activeConversationsStore.get("s1").streamingBlocks).toEqual([{ type: "text", text: "working" }]);
    expect(store.projectsStore.activityForSession(42, "s1")).toBeNull();
    expect(store.projectsStore.peekStore(42)).toBeUndefined();
    expect(store.activitySummary).toEqual({ running: 0, finished: 0 });
  });

  test("keeps active conversation state when an agent run ends", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/active-session") {
        return Response.json({
          id: "active-session",
          projectId: 42,
          taskId: null,
          parentSessionId: null,
          name: null,
          createdAt: "",
          updatedAt: "",
          activityState: null,
          messageCount: 0,
          state: { model: null, thinkingLevel: "off" },
        });
      }
      if (url === "/api/sessions/active-session/messages") return Response.json([]);
      return Response.json([], { status: 404 });
    });
    await store.setRoute("active-session");

    client.fireEvent("active-session", 42, { type: "agent_start" });
    client.fireEvent("active-session", 42, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "working" },
    });
    client.fireEvent("active-session", 42, {
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1000 }],
    });

    expect(store.activeConversationsStore.get("active-session").messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1000 },
    ]);
    expect(store.activeConversationsStore.get("active-session").streamingBlocks).toEqual([]);
  });

  test("prunes completed active conversation state after route unsubscribe", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/active-session") {
        return Response.json({
          id: "active-session",
          projectId: 42,
          taskId: null,
          parentSessionId: null,
          name: null,
          createdAt: "",
          updatedAt: "",
          activityState: null,
          messageCount: 0,
          state: { model: null, thinkingLevel: "off" },
        });
      }
      if (url === "/api/sessions/active-session/messages") return Response.json([]);
      return Response.json([], { status: 404 });
    });
    await store.setRoute("active-session");

    client.fireEvent("active-session", 42, {
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1000 }],
    });
    store.sessionCache.set("active-session", { activityState: "finished" });

    await store.setRoute(null);

    expect(store.activeConversationsStore.get("active-session")).toMatchObject({
      messages: [],
      streamingBlocks: [],
      persistedMessages: [],
    });
  });

  test("stores session-scoped websocket errors but ignores global websocket errors", () => {
    client.fireEvent("", 0, { type: "ws_error", error: "Invalid JSON" });
    expect(store.activeConversationsStore.get("s1").errorMessage).toBe("");

    client.fireEvent("s1", 0, { type: "ws_error", sessionId: "s1", error: "Missing message field" });
    expect(store.activeConversationsStore.get("s1").errorMessage).toBe("Missing message field");
  });

  test("routes task_updated to project activity reconciliation", () => {
    const handleTaskUpdated = mock(async () => {});
    store.projectsStore.handleTaskUpdated = handleTaskUpdated;

    client.fireEvent("", 42, { type: "task_updated", projectId: 42 });

    expect(handleTaskUpdated).toHaveBeenCalledWith(42);
  });

  test("session_created caches delegate metadata for session relationships", async () => {
    client.fireEvent("", 42, {
      type: "session_created",
      projectId: 42,
      sessionId: "delegate-1",
      taskId: 1,
      parentSessionId: "parent-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.sessionCache.get("delegate-1")?.parentSessionId).toBe("parent-1");
    expect(store.sessionCache.get("delegate-1")?.projectId).toBe(42);
  });

  test("setRoute exposes the active session store while initialization is in flight", async () => {
    let resolveDetail!: (response: Response) => void;
    let resolveMessages!: (response: Response) => void;
    mockFetch((url) => {
      if (url === "/api/sessions/sess-1") return new Promise<Response>((resolve) => { resolveDetail = resolve; });
      if (url === "/api/sessions/sess-1/messages") return new Promise<Response>((resolve) => { resolveMessages = resolve; });
      return Response.json([], { status: 404 });
    });

    const routePromise = store.setRoute("sess-1");
    let settled = false;
    routePromise.then(() => { settled = true; });
    await Promise.resolve();

    expect(store.activeSessionStore?.sessionId).toBe("sess-1");
    expect(settled).toBe(false);

    resolveDetail(Response.json({
      id: "sess-1",
      projectId: 42,
      taskId: null,
      parentSessionId: null,
      name: null,
      createdAt: "",
      updatedAt: "",
      activityState: null,
      messageCount: 0,
      state: { model: null, thinkingLevel: "off" },
    }));
    resolveMessages(Response.json([]));
    await routePromise;
  });

  test("setRoute refreshes the diff after session initialization", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/sess-1") {
        return Response.json({
          id: "sess-1",
          projectId: 42,
          taskId: null,
          parentSessionId: null,
          name: null,
          createdAt: "",
          updatedAt: "",
          activityState: null,
          messageCount: 0,
          state: { model: null, thinkingLevel: "off" },
        });
      }
      if (url === "/api/sessions/sess-1/messages") return Response.json([]);
      return Response.json([], { status: 404 });
    });
    const refresh = mock(async () => {});
    store.diffStore.refresh = refresh;

    await store.setRoute("sess-1");

    expect(refresh).toHaveBeenCalled();
  });

  test("setRoute replaces the active session store when the route session changes", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/sess-1") {
        return Response.json({
          id: "sess-1",
          projectId: 42,
          taskId: null,
          parentSessionId: null,
          name: null,
          createdAt: "",
          updatedAt: "",
          activityState: null,
          messageCount: 0,
          state: { model: null, thinkingLevel: "off" },
        });
      }
      if (url === "/api/sessions/sess-2") {
        return Response.json({
          id: "sess-2",
          projectId: 42,
          taskId: null,
          parentSessionId: null,
          name: null,
          createdAt: "",
          updatedAt: "",
          activityState: null,
          messageCount: 0,
          state: { model: null, thinkingLevel: "off" },
        });
      }
      if (url === "/api/sessions/sess-1/messages") return Response.json([]);
      if (url === "/api/sessions/sess-2/messages") return Response.json([]);
      return Response.json([], { status: 404 });
    });

    const initialStore = store.activeSessionStore;
    await store.setRoute("sess-1");
    const firstSessionStore = store.activeSessionStore;
    await store.setRoute("sess-2");

    expect(firstSessionStore).not.toBe(initialStore);
    expect(store.activeSessionStore).not.toBe(firstSessionStore);
    expect(store.activeSessionStore?.sessionId).toBe("sess-2");
  });

  test("session_updated applies fetched data to the active session", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/sess-1") {
        return Response.json({
          id: "sess-1",
          projectId: 42,
          taskId: null,
          parentSessionId: null,
          name: "Updated session",
          createdAt: "",
          updatedAt: "",
          activityState: "running",
          messageCount: 2,
          state: { model: null, thinkingLevel: "off" },
        });
      }
      if (url === "/api/sessions/sess-1/messages") return Response.json([]);
      return Response.json([], { status: 404 });
    });

    await store.setRoute("sess-1");
    const activeSession = store.activeSessionStore;
    if (!activeSession) throw new Error("Expected active session store");

    client.fireEvent("sess-1", 42, {
      type: "session_updated",
      sessionId: "sess-1",
      projectId: 42,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(activeSession.sessionData.name).toBe("Updated session");
    expect(activeSession.sessionData.messageCount).toBe(2);
  });

  test("session_updated fetches canonical session data and applies activityState", async () => {
    store.sessionCache.set("sess-1", { projectId: 42, activityState: "finished" });
    mockFetch((url) => {
      if (url === "/api/sessions/sess-1") {
        return Response.json({
          id: "sess-1",
          projectId: 42,
          taskId: null,
          parentSessionId: null,
          name: null,
          createdAt: "",
          updatedAt: "",
          activityState: null,
          messageCount: 0,
          state: { model: null, thinkingLevel: "off" },
        });
      }
      return Response.json([], { status: 404 });
    });

    client.fireEvent("sess-1", 42, {
      type: "session_updated",
      sessionId: "sess-1",
      projectId: 42,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.projectsStore.activityForSession(42, "sess-1")).toBeNull();
  });

  test("does not fire mark-as-viewed for background session updates", async () => {
    const requestedUrls: string[] = [];
    mockFetch((url) => {
      requestedUrls.push(String(url));
      if (url === "/api/sessions/bg") {
        return Response.json({
          id: "bg",
          projectId: 42,
          taskId: null,
          parentSessionId: null,
          name: null,
          createdAt: "",
          updatedAt: "",
          activityState: "finished",
          messageCount: 0,
          state: { model: null, thinkingLevel: "off" },
        });
      }
      return Response.json({ ok: true });
    });

    client.fireEvent("bg", 42, {
      type: "session_updated",
      sessionId: "bg",
      projectId: 42,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestedUrls).not.toContain("/api/sessions/bg/activity");
  });

});
