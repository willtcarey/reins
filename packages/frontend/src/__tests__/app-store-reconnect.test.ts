/**
 * Tests for AppStore reconnect catch-up behavior.
 *
 * On WS reconnect (connection=true), the store should:
 *  - Re-fetch the project list
 *  - Refresh all loaded project stores (session/task lists)
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

  test("reconnect calls refreshAll on projectsStore", () => {
    const calls: string[] = [];
    store.projectsStore.refreshAll = mock(async () => { calls.push("refreshAll"); });
    store.projectsStore.fetchProjects = mock(async () => { calls.push("fetchProjects"); });

    client.fireConnection(true);

    expect(calls).toContain("fetchProjects");
    expect(calls).toContain("refreshAll");
  });

  test("reconnect refreshes active session messages", () => {
    store.projectsStore.fetchProjects = mock(async () => {});
    store.projectsStore.refreshAll = mock(async () => {});

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

    client.fireConnection(true);

    expect(refreshMessagesSpy).toHaveBeenCalled();
  });

  test("reconnect does not call refreshAll when disconnecting", () => {
    const refreshAllSpy = mock(async () => {});
    store.projectsStore.refreshAll = refreshAllSpy;

    client.fireConnection(false);

    expect(refreshAllSpy).not.toHaveBeenCalled();
  });
});
