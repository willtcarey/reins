/**
 * Tests for AppStore activity tracking with projectId support.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { AppStore } from "../models/stores/app-store.js";
import { StubClient } from "./helpers/stub-client.js";

describe("AppStore activity tracking", () => {
  let client: StubClient;
  let store: AppStore;

  beforeEach(() => {
    client = new StubClient();
    store = new AppStore(client);
  });

  test("agent_start sets running activity with projectId", () => {
    client.fireEvent("s1", 42, { type: "agent_start" });

    expect(store.getActivity("s1")).toBe("running");
    expect(store.getActivityProjectId("s1")).toBe(42);
  });

  test("agent_end sets finished activity for non-active session", () => {
    client.fireEvent("s1", 42, { type: "agent_start" });
    client.fireEvent("s1", 42, { type: "agent_end" });

    expect(store.getActivity("s1")).toBe("finished");
    expect(store.getActivityProjectId("s1")).toBe(42);
  });

  test("activityMap returns Map<string, ActivityState> without projectId", () => {
    client.fireEvent("s1", 42, { type: "agent_start" });
    client.fireEvent("s2", 99, { type: "agent_start" });

    const map = store.activityMap;
    expect(map.get("s1")).toBe("running");
    expect(map.get("s2")).toBe("running");
    // Values should be plain ActivityState, not objects
    expect(typeof map.get("s1")).toBe("string");
  });

  test("activityByProject aggregates activity by projectId", () => {
    client.fireEvent("s1", 42, { type: "agent_start" });
    client.fireEvent("s2", 42, { type: "agent_start" });
    client.fireEvent("s2", 42, { type: "agent_end" }); // finished

    const byProject = store.activityByProject;
    // running trumps finished for project 42
    expect(byProject.get(42)).toBe("running");
  });

  test("activityByProject shows finished when all sessions finished", () => {
    client.fireEvent("s1", 42, { type: "agent_start" });
    client.fireEvent("s1", 42, { type: "agent_end" });

    const byProject = store.activityByProject;
    expect(byProject.get(42)).toBe("finished");
  });

  test("clearActivity removes session from tracking", () => {
    client.fireEvent("s1", 42, { type: "agent_start" });
    store.clearActivity("s1");

    expect(store.getActivity("s1")).toBeUndefined();
    expect(store.getActivityProjectId("s1")).toBeUndefined();
  });

  test("activitySummary counts correctly", () => {
    client.fireEvent("s1", 1, { type: "agent_start" });
    client.fireEvent("s2", 2, { type: "agent_start" });
    client.fireEvent("s2", 2, { type: "agent_end" });

    const summary = store.activitySummary;
    expect(summary.running).toBe(1);
    expect(summary.finished).toBe(1);
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
