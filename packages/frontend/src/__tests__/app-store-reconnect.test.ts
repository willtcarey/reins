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

  test("reconnect calls refreshAll on projectCollectionStore", () => {
    const calls: string[] = [];
    store.projectCollectionStore.refreshAll = mock(async () => { calls.push("refreshAll"); });
    store.projectCollectionStore.fetchProjects = mock(async () => { calls.push("fetchProjects"); });

    client.fireConnection(true);

    expect(calls).toContain("fetchProjects");
    expect(calls).toContain("refreshAll");
  });

  test("reconnect does not call refreshAll when disconnecting", () => {
    const refreshAllSpy = mock(async () => {});
    store.projectCollectionStore.refreshAll = refreshAllSpy;

    client.fireConnection(false);

    expect(refreshAllSpy).not.toHaveBeenCalled();
  });
});
