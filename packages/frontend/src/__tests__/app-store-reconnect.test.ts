/**
 * Tests for AppStore reconnect catch-up behavior.
 *
 * On WS reconnect (connection=true), the store should:
 *  - Re-fetch the project list
 *  - Refresh all loaded project stores (session/task lists)
 *  - Re-fetch the active session's messages if one is being viewed
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { AppStore } from "../stores/app-store.js";

// Minimal stub of AppClient that lets us fire connection events
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

  fireConnection(connected: boolean) {
    for (const l of this.connectionListeners) l(connected);
  }

  fireEvent(sessionId: string, projectId: number, event: any) {
    for (const l of this.eventListeners) l(sessionId, projectId, event);
  }

  connect() {}
  disconnect() {}
  get isConnected() { return false; }
}

describe("AppStore reconnect catch-up", () => {
  let client: StubClient;
  let store: AppStore;

  beforeEach(() => {
    client = new StubClient();
    store = new AppStore(client as any);
  });

  test("reconnect calls refreshAll on projectCollectionStore", () => {
    const calls: string[] = [];
    store.projectCollectionStore.refreshAll = mock(async () => { calls.push("refreshAll"); }) as any;
    store.projectCollectionStore.fetchProjects = mock(async () => { calls.push("fetchProjects"); }) as any;

    client.fireConnection(true);

    expect(calls).toContain("fetchProjects");
    expect(calls).toContain("refreshAll");
  });

  test("reconnect does not call refreshAll when disconnecting", () => {
    const refreshAllSpy = mock(async () => {});
    store.projectCollectionStore.refreshAll = refreshAllSpy as any;

    client.fireConnection(false);

    expect(refreshAllSpy).not.toHaveBeenCalled();
  });
});
