import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AppStore } from "../../../models/stores/app-store.js";
import { StubClient } from "../../helpers/stub-client.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

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
          placement: { available: true, nodeId: "internal", nodeName: "Internal" },
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
});
