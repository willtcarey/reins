/**
 * Tests for AppStore reconnect catch-up behavior.
 *
 * On WS reconnect (connection=true), the store should:
 *  - Re-fetch the project list
 *  - Delegate project-domain reconnect catch-up
 *  - Re-fetch the active session's messages if one is being viewed
 */
import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { AppStore } from "../models/stores/app-store.js";
import { StubClient } from "./helpers/stub-client.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";

describe("AppStore reconnect catch-up", () => {
  let client: StubClient;
  let store: AppStore;

  beforeEach(() => {
    client = new StubClient();
    store = new AppStore(client);
    restoreFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  test("reconnect fetches projects and delegates project reconnect catch-up", () => {
    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.handleReconnect = mock(async () => {});

    client.fireConnection(true);

    expect(store.projectsStore.fetchProjects).toHaveBeenCalled();
    // handleReconnect is called with activeSessionId (null when no active session)
    expect(store.projectsStore.handleReconnect).toHaveBeenCalled();
  });

  test("reconnect refreshes active session messages", () => {
    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.handleReconnect = mock(async () => {});

    // Set up an active session
    const activeStore = store.activeSessionStore;
    activeStore.sessionId = "sess-1";
    activeStore.sessionData = {
      id: "sess-1",
      task_id: null,
      activityState: null,
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "high",
        isStreaming: false,
        messageCount: 2,
      },
    };

    const refreshMessagesSpy = mock(async () => {});
    activeStore.refreshMessages = refreshMessagesSpy;
    activeStore.refreshSession = mock(async () => {});

    client.fireConnection(true);

    expect(store.projectsStore.handleReconnect).toHaveBeenCalledWith("sess-1");
    expect(refreshMessagesSpy).toHaveBeenCalled();
  });

  test("reconnect does not call handleReconnect when disconnecting", () => {
    const handleReconnectSpy = mock(async () => {});
    store.projectsStore.handleReconnect = handleReconnectSpy;

    client.fireConnection(false);

    expect(handleReconnectSpy).not.toHaveBeenCalled();
  });

  test("connect fetches activity snapshot and populates project-level activity", async () => {
    const snapshot = [
      { id: "s1", activity_state: "running" as const, project_id: 10 },
      { id: "s2", activity_state: "finished" as const, project_id: 20 },
    ];

    mockFetch((url) => {
      if (url === "/api/activity") {
        return new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/projects") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("", { status: 404 });
    });

    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.handleReconnect = mock(async () => {});

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
      if (url === "/api/activity") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("", { status: 404 });
    });

    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.handleReconnect = mock(async () => {});

    // Should not throw
    client.fireConnection(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(store.projectsStore.activitySummary).toEqual({ running: 0, finished: 0 });
  });
});
