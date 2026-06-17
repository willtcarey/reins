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
  });

  test("routes agent activity events to the event project store", () => {
    client.fireEvent("s1", 42, { type: "agent_start" });

    // Activity is tracked via shared ActivityStore — works even without a loaded ProjectStore
    expect(store.projectsStore.activityForSession(42, "s1")).toBe("running");
    // handleAgentStart does NOT create a ProjectStore
    expect(store.projectsStore.peekStore(42)).toBeUndefined();

    client.fireEvent("s1", 42, { type: "agent_end" });

    expect(store.projectsStore.activityForSession(42, "s1")).toBe("finished");
    expect(store.projectsStore.peekStore(7)).toBeUndefined();
  });

  test("activitySummary aggregates project store activity for shell state", () => {
    client.fireEvent("s1", 1, { type: "agent_start" });
    client.fireEvent("s2", 2, { type: "agent_start" });
    client.fireEvent("s2", 2, { type: "agent_end" });

    expect(store.activitySummary).toEqual({ running: 1, finished: 1 });
  });

  test("routes task_updated to project activity reconciliation", () => {
    const handleTaskUpdated = mock(async () => {});
    store.projectsStore.handleTaskUpdated = handleTaskUpdated;

    client.fireEvent("", 42, { type: "task_updated", projectId: 42 });

    expect(handleTaskUpdated).toHaveBeenCalledWith(42);
  });

  test("routes active session agent_end with suppressUnread instead of leaking active session id", () => {
    const handleAgentEnd = mock(() => {});
    store.projectsStore.handleAgentEnd = handleAgentEnd;
    store.activeSessionStore.sessionId = "active";

    client.fireEvent("active", 42, { type: "agent_end" });
    client.fireEvent("background", 42, { type: "agent_end" });

    expect(handleAgentEnd).toHaveBeenNthCalledWith(1, 42, "active", { suppressUnread: true });
    expect(handleAgentEnd).toHaveBeenNthCalledWith(2, 42, "background", { suppressUnread: false });
  });

  test("session_created marks delegate sessions on their project before agent_end", () => {
    client.fireEvent("", 42, {
      type: "session_created",
      projectId: 42,
      sessionId: "delegate-1",
      taskId: 1,
      parentSessionId: "parent-1",
    });

    const projectStore = store.projectsStore.peekStore(42)!;
    client.fireEvent("delegate-1", 42, { type: "agent_start" });
    expect(projectStore.activityForSession("delegate-1")).toBe("running");

    client.fireEvent("delegate-1", 42, { type: "agent_end" });
    expect(projectStore.activityForSession("delegate-1")).toBeUndefined();
  });

  test("session_updated applies fetched data to the active session", async () => {
    const activeSession = store["_activeSession"];
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
          state: { model: null, thinkingLevel: "off", isStreaming: false, messageCount: 2 },
        });
      }
      if (url === "/api/sessions/sess-1/messages") return Response.json([]);
      return Response.json([], { status: 404 });
    });

    await store.setRoute("sess-1");

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
    store.projectsStore.setFinished("sess-1", 42);
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
          state: { model: null, thinkingLevel: "off", isStreaming: false, messageCount: 0 },
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

    expect(store.projectsStore.activityForSession(42, "sess-1")).toBeUndefined();
  });

  test("markActiveSessionViewed delegates to markSessionViewed on projects store", async () => {
    const activeSession = store["_activeSession"];
    activeSession.sessionId = "s1";
    Object.defineProperty(activeSession, "projectId", { value: 42 });

    store.projectsStore.setRunning("s1", 42);
    store.projectsStore.setFinished("s1", 42);

    mockFetch(() => Response.json({ ok: true }));

    store.markActiveSessionViewed();

    // Activity should be cleared (optimistic update happens synchronously)
    expect(store.projectsStore.activityForSession(42, "s1")).toBeUndefined();
  });

  test("fires mark-as-viewed request when active session finishes while being viewed", async () => {
    const activeSession = store["_activeSession"];
    activeSession.sessionId = "s1";
    Object.defineProperty(activeSession, "projectId", { value: 42 });

    // Pre-populate the project store
    const projectStore = store.projectsStore.getStore(42);

    let capturedUrl: string | undefined;
    mockFetch((url) => {
      capturedUrl = url;
      return Response.json({ ok: true });
    });

    try {
      // Session starts running
      client.fireEvent("s1", 42, { type: "agent_start" });
      expect(projectStore.activityForSession("s1")).toBe("running");

      // Session ends while being viewed — should suppress local unread AND fire server request
      client.fireEvent("s1", 42, { type: "agent_end" });

      // Locally, suppressUnread keeps activity cleared (no finished indicator)
      expect(projectStore.activityForSession("s1")).toBeUndefined();

      // Should have fired the mark-as-viewed request to clear server-side state
      expect(capturedUrl).toBeDefined();
      expect(capturedUrl).toContain("/api/sessions/s1/activity");
    } finally {
      restoreFetch();
    }
  });

  test("does not fire mark-as-viewed for background session agent_end", async () => {
    let fetchCalled = false;
    mockFetch(() => {
      fetchCalled = true;
      return Response.json({ ok: true });
    });

    try {
      // Background session ends — should NOT fire mark-as-viewed
      client.fireEvent("bg", 42, { type: "agent_end" });

      // Give the handleAgentEnd setTimeout a tick to settle
      await new Promise((r) => setTimeout(r, 10));

      expect(fetchCalled).toBe(false);
    } finally {
      restoreFetch();
    }
  });

});
