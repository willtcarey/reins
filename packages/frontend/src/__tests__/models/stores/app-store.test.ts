import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AppStore } from "../../../models/stores/app-store.js";
import { StubClient } from "../../helpers/stub-client.js";

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

    const projectStore = store.projectsStore.peekStore(42)!;
    expect(projectStore.activityForSession("s1")).toBe("running");

    client.fireEvent("s1", 42, { type: "agent_end" });

    expect(projectStore.activityForSession("s1")).toBe("finished");
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

  test("session_updated refreshes the active session data", () => {
    const activeSession = store["_activeSession"];
    activeSession.sessionId = "sess-1";
    activeSession.refreshSession = mock(async () => {});

    client.fireEvent("sess-1", 42, {
      type: "session_updated",
      sessionId: "sess-1",
      projectId: 42,
    });

    expect(activeSession.refreshSession).toHaveBeenCalledTimes(1);
  });

});
