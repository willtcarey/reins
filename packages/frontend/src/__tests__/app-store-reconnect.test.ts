/**
 * Tests for AppStore reconnect catch-up behavior.
 *
 * On WS reconnect (connection=true), the store should:
 *  - Re-fetch the project list
 *  - Delegate project-domain reconnect catch-up
 *  - Re-fetch the active session's messages if one is being viewed
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { AppStore } from "../models/stores/app-store.js";
import { StubClient } from "./helpers/stub-client.js";

describe("AppStore reconnect catch-up", () => {
  let client: StubClient;
  let store: AppStore;

  beforeEach(() => {
    client = new StubClient();
    store = new AppStore(client);
  });

  test("reconnect fetches projects and delegates project reconnect catch-up", () => {
    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.handleReconnect = mock(async () => {});

    client.fireConnection(true);

    expect(store.projectsStore.fetchProjects).toHaveBeenCalled();
    expect(store.projectsStore.handleReconnect).toHaveBeenCalledWith(null);
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
});
