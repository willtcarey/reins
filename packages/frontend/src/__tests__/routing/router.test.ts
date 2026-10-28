import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import "../helpers/local-storage.js";
import { FrontendRouter } from "../../routing/router.js";
import {
  closeSettings,
  createAppRouter,
  getLastHash,
  mainViewHash,
  mainViewOf,
  newSessionHash,
  openSettings,
  projectHistoryHash,
  saveHash,
  sessionHash,
  settingsHash,
  showSettingsSection,
} from "../../routing/app-router.js";

describe("FrontendRouter", () => {
  test("resolves registered routes and builds their canonical hashes", () => {
    const router = createAppRouter();

    expect(router.resolve("#/session/agent%2Fone")).toEqual({
      name: "session",
      params: { sessionId: "agent/one" },
    });
    expect(router.resolve("#/projects/42/history")).toEqual({
      name: "project-history",
      params: { projectId: "42" },
    });
    expect(sessionHash("agent/one")).toBe("#/session/agent%2Fone");
    expect(projectHistoryHash(42)).toBe("#/projects/42/history");
  });

  test("allows additional page routes to register matching, URLs, and rendering together", () => {
    const router = new FrontendRouter<{ prefix: string }, string>();
    router.register({
      name: "plugin-dashboard",
      pattern: "/projects/:projectId/plugins/:pluginId",
      renderPage: (route, context) => `${context.prefix}:${route.params.pluginId}`,
    });

    const route = router.resolve("#/projects/7/plugins/github%2Finbox");
    expect(route).toEqual({
      name: "plugin-dashboard",
      params: { projectId: "7", pluginId: "github/inbox" },
    });
    expect(router.hash("plugin-dashboard", { projectId: 7, pluginId: "github/inbox" }))
      .toBe("#/projects/7/plugins/github%2Finbox");
    expect(router.renderPage(route, { prefix: "plugin" })).toBe("plugin:github/inbox");
  });

  test("gives a hash's query as parameters, a path parameter winning, and puts the parameters a pattern does not name in the query", () => {
    const router = new FrontendRouter();
    router.register({ name: "plugin", pattern: "/plugins/:pluginId" });

    expect(router.resolve("#/plugins/inbox?tab=open%20items&pluginId=other")).toEqual({
      name: "plugin",
      params: { tab: "open items", pluginId: "inbox" },
    });
    expect(router.hash("plugin", { pluginId: "inbox", tab: "open items" })).toBe("#/plugins/inbox?tab=open+items");
    expect(router.hash("plugin", { pluginId: "inbox" })).toBe("#/plugins/inbox");
  });

  test("resolves the new session page, with the project and task chosen in it", () => {
    const router = createAppRouter();

    expect(router.resolve("#/new")).toEqual({ name: "new-session", params: {} });
    expect(router.resolve("#/new?project=7")).toEqual({ name: "new-session", params: { project: "7" } });
    expect(router.resolve("#/new?project=7&task=3")).toEqual({ name: "new-session", params: { project: "7", task: "3" } });
    expect(router.resolve("#/new?project=seven")).toEqual({ name: "empty", params: {} });
    expect(router.resolve("#/new?task=3")).toEqual({ name: "empty", params: {} });
    expect(newSessionHash({ projectId: null, taskId: null })).toBe("#/new");
    expect(newSessionHash({ projectId: 7, taskId: null })).toBe("#/new?project=7");
    expect(newSessionHash({ projectId: 7, taskId: 3 })).toBe("#/new?project=7&task=3");
  });

  test("resolves the settings page and its sections", () => {
    const router = createAppRouter();

    expect(router.resolve("#/settings")).toEqual({ name: "settings", params: {} });
    expect(router.resolve("#/settings/nodes")).toEqual({ name: "settings-section", params: { section: "nodes" } });
    expect(settingsHash()).toBe("#/settings");
    expect(settingsHash("models")).toBe("#/settings/models");
  });

  test("returns the empty route for unknown or malformed hashes", () => {
    const router = createAppRouter();

    expect(router.resolve("#/unknown")).toEqual({ name: "empty", params: {} });
    expect(router.resolve("#/projects/not-a-number/history")).toEqual({ name: "empty", params: {} });
    expect(router.resolve("#/settings/unknown")).toEqual({ name: "empty", params: {} });
  });
});

describe("the main area's views", () => {
  test("are the session and new session routes, as views", () => {
    const router = createAppRouter();

    expect(mainViewOf(router.resolve("#/session/s1"))).toEqual({ view: "session", sessionId: "s1" });
    expect(mainViewOf(router.resolve("#/new?project=7&task=3"))).toEqual({ view: "new-session", projectId: 7, taskId: 3 });
    expect(mainViewOf(router.resolve("#/new"))).toEqual({ view: "new-session", projectId: null, taskId: null });
    expect(mainViewOf(router.resolve("#/settings"))).toBeNull();
    expect(mainViewOf(router.resolve("#/"))).toBeNull();
  });

  test("are one object for as long as the app keeps its route, which is until the URL changes, so rendering the route again is not opening its view again", () => {
    const router = createAppRouter();
    const route = router.resolve("#/new?project=7");

    expect(mainViewOf(route)).toBe(mainViewOf(route));
    expect(mainViewOf(router.resolve("#/new?project=7"))).not.toBe(mainViewOf(route));
  });

  test("go to their routes, and no other view has one", () => {
    expect(mainViewHash({ view: "session", sessionId: "s1" })).toBe("#/session/s1");
    expect(mainViewHash({ view: "new-session", projectId: 7, taskId: 3 })).toBe("#/new?project=7&task=3");
    expect(mainViewHash({ view: "new-session", projectId: null, taskId: null })).toBe("#/new");
    expect(mainViewHash({ view: "session" })).toBeNull();
    expect(mainViewHash({ view: "new-session", projectId: "7", taskId: null })).toBeNull();
    expect(mainViewHash({ view: "new-session", projectId: null, taskId: 3 })).toBeNull();
    expect(mainViewHash({ view: "file", path: "README.md" })).toBeNull();
  });
});

describe("settings navigation", () => {
  const originals = {
    location: globalThis.location,
    history: globalThis.history,
    window: globalThis.window,
    HashChangeEvent: Reflect.get(globalThis, "HashChangeEvent"),
  };

  /** A browser whose history entries are recorded, so Back is observable. */
  function installBrowser(hash: string) {
    const entries = [hash];
    const location = { hash };
    const history = {
      back: mock(() => {
        entries.pop();
        location.hash = entries.at(-1) ?? "";
      }),
      replaceState: (_state: unknown, _title: string, url: string) => {
        entries[entries.length - 1] = url;
        location.hash = url;
      },
    };
    Reflect.set(globalThis, "location", new Proxy(location, {
      set(target, key, value) {
        if (key === "hash") entries.push(value);
        return Reflect.set(target, key, value);
      },
    }));
    Reflect.set(globalThis, "history", history);
    Reflect.set(globalThis, "window", { dispatchEvent() {} });
    Reflect.set(globalThis, "HashChangeEvent", class extends Event {});
    return { location, entries };
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(originals)) Reflect.set(globalThis, key, value);
  });

  test("closing settings opened from the app returns there in one step, whatever sections were visited", () => {
    const browser = installBrowser("#/session/s1");

    openSettings();
    showSettingsSection("nodes");
    showSettingsSection("models");
    closeSettings();

    expect(browser.location.hash).toBe("#/session/s1");
    expect(browser.entries).toEqual(["#/session/s1"]);
  });

  test("closing settings opened directly from its URL goes to the workspace", () => {
    const browser = installBrowser("#/settings/nodes");

    closeSettings();

    expect(browser.location.hash).toBe("#/");
    expect(browser.entries).toEqual(["#/"]);
  });
});

describe("last route persistence", () => {
  beforeEach(() => localStorage.removeItem("reins:last-hash"));
  afterEach(() => localStorage.removeItem("reins:last-hash"));

  test("stores and restores the most recently viewed hash", () => {
    expect(getLastHash()).toBeNull();

    saveHash("#/session/first");
    saveHash("#/projects/42/history");

    expect(getLastHash()).toBe("#/projects/42/history");
  });
});
