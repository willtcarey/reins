import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import "../helpers/local-storage.js";
import { FrontendRouter } from "../../routing/router.js";
import {
  closeSettings,
  createAppRouter,
  getLastHash,
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
