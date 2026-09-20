import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "../helpers/local-storage.js";
import { FrontendRouter } from "../../routing/router.js";
import {
  createAppRouter,
  getLastHash,
  projectHistoryHash,
  saveHash,
  sessionHash,
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

  test("returns the empty route for unknown or malformed hashes", () => {
    const router = createAppRouter();

    expect(router.resolve("#/unknown")).toEqual({ name: "empty", params: {} });
    expect(router.resolve("#/projects/not-a-number/history")).toEqual({ name: "empty", params: {} });
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
