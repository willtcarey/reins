/**
 * Tests for AppStore activity tracking with projectId support.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { AppStore, type ActivityState } from "../stores/app-store.js";

// Minimal stub of AppClient that lets us fire events
class StubClient {
  private eventListeners = new Set<(sessionId: string, projectId: number, event: any) => void>();
  private connectionListeners = new Set<(connected: boolean) => void>();

  onEvent(listener: (sessionId: string, projectId: number, event: any) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  // Test helpers
  fireEvent(sessionId: string, projectId: number, event: any) {
    for (const l of this.eventListeners) l(sessionId, projectId, event);
  }

  fireConnection(connected: boolean) {
    for (const l of this.connectionListeners) l(connected);
  }

  // Stubs for methods AppStore might call
  connect() {}
  disconnect() {}
  get isConnected() { return false; }
}

describe("AppStore activity tracking", () => {
  let client: StubClient;
  let store: AppStore;

  beforeEach(() => {
    client = new StubClient();
    store = new AppStore(client as any);
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
});
