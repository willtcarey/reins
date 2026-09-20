import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import "../helpers/local-storage.js";
import { AppRouteController } from "../../controllers/app-route-controller.js";
import type { Route } from "../../routing/router.js";

function fakeHost(): ReactiveControllerHost & { requestUpdate: ReturnType<typeof mock> } {
  return {
    addController(_controller: ReactiveController) {},
    removeController(_controller: ReactiveController) {},
    requestUpdate: mock(() => {}),
    updateComplete: Promise.resolve(true),
  };
}

function installRouteGlobals(hash: string) {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
  let hashChangeListener: (() => void) | null = null;
  const locationState = { hash };
  const replaceState = mock((_state: unknown, _title: string, url?: string | URL | null) => {
    if (typeof url === "string") locationState.hash = url;
  });
  Object.defineProperty(globalThis, "location", { configurable: true, value: locationState });
  Object.defineProperty(globalThis, "history", { configurable: true, value: { replaceState } });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: mock((type: string, listener: () => void) => {
        if (type === "hashchange") hashChangeListener = listener;
      }),
      removeEventListener: mock((type: string, listener: () => void) => {
        if (type === "hashchange" && hashChangeListener === listener) hashChangeListener = null;
      }),
    },
  });
  return {
    get hashChangeListener() { return hashChangeListener; },
    locationState,
    replaceState,
    restore() {
      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
      else Reflect.deleteProperty(globalThis, "location");
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (originalHistory) Object.defineProperty(globalThis, "history", originalHistory);
      else Reflect.deleteProperty(globalThis, "history");
    },
  };
}

afterEach(() => localStorage.clear());

describe("AppRouteController", () => {
  test("restores the last registered hash and reports the resolved route", () => {
    const globals = installRouteGlobals("");
    localStorage.setItem("reins:last-hash", "#/session/restored");
    const host = fakeHost();
    const onRouteChange = mock((_route: Route) => {});

    new AppRouteController(host, { onRouteChange }).connect();

    expect(globals.replaceState).toHaveBeenCalledWith(null, "", "#/session/restored");
    expect(onRouteChange).toHaveBeenCalledWith({
      name: "session",
      params: { sessionId: "restored" },
    });
    expect(host.requestUpdate).toHaveBeenCalledTimes(1);
    globals.restore();
  });

  test("persists hash changes and reports any resolved route without route-specific callbacks", () => {
    const globals = installRouteGlobals("");
    const host = fakeHost();
    const onRouteChange = mock((_route: Route) => {});
    const controller = new AppRouteController(host, { onRouteChange });
    controller.connect();

    globals.locationState.hash = "#/projects/42/history";
    globals.hashChangeListener?.();

    expect(localStorage.getItem("reins:last-hash")).toBe("#/projects/42/history");
    expect(onRouteChange).toHaveBeenLastCalledWith({
      name: "project-history",
      params: { projectId: "42" },
    });
    expect(host.requestUpdate).toHaveBeenCalledTimes(2);
    globals.restore();
  });
});
