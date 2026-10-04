import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AppStore } from "../../../models/stores/app-store.js";
import { StubClient } from "../../helpers/stub-client.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

/** A task-1 child session of "parent-1" in project 42, as `GET /api/sessions/:id` returns it. */
function childDetail(id: string, background: boolean, activityState: "running" | "finished") {
  return {
    id, projectId: 42, taskId: 1, parentSessionId: "parent-1", name: null, createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", activityState, pinnedAt: null, archivedAt: null, background, messageCount: 1,
    pendingOperation: null, placement: { available: true, nodeId: "internal", nodeName: "Internal", path: "" },
    state: { model: null, thinkingLevel: "off" },
  };
}

describe("AppStore application runtime", () => {
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

  test("does not expose project, task, or session mutation facades", () => {
    expect(Object.getPrototypeOf(store)).not.toHaveProperty("createProject");
    expect(Object.getPrototypeOf(store)).not.toHaveProperty("updateProject");
    expect(Object.getPrototypeOf(store)).not.toHaveProperty("deleteProject");
    expect(Object.getPrototypeOf(store)).not.toHaveProperty("updateTask");
    expect(Object.getPrototypeOf(store)).not.toHaveProperty("deleteTask");
    expect(Object.getPrototypeOf(store)).not.toHaveProperty("createSession");
    expect(Object.getPrototypeOf(store)).not.toHaveProperty("createTaskSession");
    expect(Object.getPrototypeOf(store)).not.toHaveProperty("generateTask");
  });

  test("keeps conversation state long-lived for session events outside a workspace", () => {
    const start = { role: "assistant" as const, content: [], timestamp: 100 };
    const message = { ...start, content: [{ type: "text" as const, text: "working" }] };
    client.fireMessage({ type: "event", sessionId: "s1", projectId: 42, seq: 1, emittedAt: 0, event: { type: "agent_start" } });
    client.fireMessage({ type: "event", sessionId: "s1", projectId: 42, seq: 2, emittedAt: 0, event: { type: "message_start", streamId: "stream-1", message: start } });
    client.fireMessage({
      type: "event",
      sessionId: "s1",
      projectId: 42,
      seq: 3, emittedAt: 0,
      event: { type: "message_update", streamId: "stream-1", message, assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
    });

    expect(store.activeConversationsStore.get("s1").streamingMessages.map(({ raw }) => raw)).toEqual([message]);
    expect(store.projectsStore.activityForSession(42, "s1")).toBeNull();
  });

  test("stores session-scoped websocket errors but ignores global websocket errors", () => {
    client.fireMessage({ type: "error", error: "Invalid JSON" });
    expect(store.activeConversationsStore.get("s1").errorMessage).toBe("");

    client.fireMessage({ type: "error", sessionId: "s1", error: "Missing message field" });
    expect(store.activeConversationsStore.get("s1").errorMessage).toBe("Missing message field");
  });

  test("routes task updates to long-lived project reconciliation", () => {
    const handleTaskUpdated = mock(async () => {});
    store.projectsStore.handleTaskUpdated = handleTaskUpdated;

    client.fireMessage({ type: "task_updated", projectId: 42 });

    expect(handleTaskUpdated).toHaveBeenCalledWith(42);
  });

  test("caches delegate metadata from session creation broadcasts", async () => {
    client.fireMessage({
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

  test("refreshes canonical session metadata after a session update", async () => {
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
          placement: { available: true, nodeId: "internal", nodeName: "Internal", path: "" },
          state: { model: null, thinkingLevel: "off" },
        });
      }
      return Response.json([]);
    });

    client.fireMessage({
      type: "session_updated",
      sessionId: "sess-1",
      projectId: 42,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.sessionCache.getDetail("sess-1")?.name).toBe("Updated session");
    expect(store.sessionCache.getDetail("sess-1")?.messageCount).toBe(2);
  });

  test("keeps an updated background session out of session lists and activity badges", async () => {
    mockFetch((url) => {
      if (url === "/api/sessions/hidden") return Response.json(childDetail("hidden", true, "running"));
      if (url === "/api/sessions/visible") return Response.json(childDetail("visible", false, "finished"));
      return Response.json([]);
    });

    client.fireMessage({ type: "session_updated", sessionId: "hidden", projectId: 42 });
    client.fireMessage({ type: "session_updated", sessionId: "visible", projectId: 42 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const project = store.projectsStore.getStore(42);
    expect(store.sessionCache.get("hidden")?.activityState).toBe("running");
    expect(project.taskSessionsFor(1).map((session) => session.id)).toEqual(["visible"]);
    expect(project.runningChildSessionsFor("parent-1")).toEqual([]);
    expect(project.activityForTask(1)).toBe("finished");
    expect(store.projectsStore.activityForProject(42)).toBe("finished");
    expect(store.activitySummary).toEqual({ running: 0, finished: 1 });
  });
});
