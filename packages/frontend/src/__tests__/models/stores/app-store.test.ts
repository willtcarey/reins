import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AppStore } from "../../../models/stores/app-store.js";
import { StubClient } from "../../helpers/stub-client.js";
import { mockFetch } from "../../helpers/mock-fetch.js";

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

  test("raw agent activity events do not mutate project activity", () => {
    client.fireEvent("s1", 42, { type: "agent_start" });
    client.fireEvent("s1", 42, { type: "agent_end" });

    expect(store.projectsStore.activityForSession(42, "s1")).toBeNull();
    expect(store.projectsStore.peekStore(42)).toBeUndefined();
    expect(store.activitySummary).toEqual({ running: 0, finished: 0 });
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

    expect(store.projectsStore.activityForSession(42, "sess-1")).toBeNull();
  });

  test("fires mark-as-viewed request when active session update fetches finished activity", async () => {
    let activityState: "running" | "finished" = "running";
    const requestedUrls: string[] = [];
    mockFetch((url) => {
      requestedUrls.push(String(url));
      if (url === "/api/sessions/s1") {
        return Response.json({
          id: "s1",
          projectId: 42,
          taskId: null,
          parentSessionId: null,
          name: null,
          createdAt: "",
          updatedAt: "",
          activityState,
          messageCount: 0,
          state: { model: null, thinkingLevel: "off", isStreaming: false, messageCount: 0 },
        });
      }
      if (url === "/api/sessions/s1/messages") return Response.json([]);
      return Response.json({ ok: true });
    });

    await store.setRoute("s1");
    activityState = "finished";

    client.fireEvent("s1", 42, {
      type: "session_updated",
      sessionId: "s1",
      projectId: 42,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.projectsStore.activityForSession(42, "s1")).toBeNull();
    expect(requestedUrls).toContain("/api/sessions/s1/activity");
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
          state: { model: null, thinkingLevel: "off", isStreaming: false, messageCount: 0 },
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
