import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import "./helpers/local-storage.js";
import { AppRouteController } from "../controllers/app-route-controller.js";

function fakeHost(): ReactiveControllerHost {
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

  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: locationState,
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: { replaceState },
  });
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

function createStore(initial: { sessionId?: string; projectId?: number | null } = {}) {
  const store = {
    sessionId: initial.sessionId ?? "",
    projectId: initial.projectId ?? null,
    setRoute: mock(async (sessionId: string | null) => {
      store.sessionId = sessionId ?? "";
    }),
  };
  return store;
}

afterEach(() => {
  localStorage.clear();
});

describe("AppRouteController", () => {
  test("restores the last session hash on initial connect", async () => {
    const globals = installRouteGlobals("");
    localStorage.setItem("reins:last-hash", "#/session/restored");
    const store = createStore();

    new AppRouteController(fakeHost(), { store }).connect();
    await Promise.resolve();

    expect(globals.replaceState).toHaveBeenCalledWith(null, "", "#/session/restored");
    expect(store.setRoute).toHaveBeenCalledWith("restored");
    globals.restore();
  });

  test("notifies session changes before route initialization finishes", async () => {
    const store = createStore();
    const onSessionChange = mock(() => {});
    let resolveRoute!: () => void;
    store.setRoute = mock((sessionId: string | null) => {
      store.sessionId = sessionId ?? "";
      return new Promise<void>((resolve) => { resolveRoute = resolve; });
    });

    const routePromise = new AppRouteController(fakeHost(), { store, onSessionChange })
      .applyRoute({ sessionId: "s1" });
    await Promise.resolve();

    expect(onSessionChange).toHaveBeenCalled();

    resolveRoute();
    await routePromise;
  });

  test("handles hash changes with pane, project, and recency callbacks", async () => {
    const globals = installRouteGlobals("");
    const store = createStore({ sessionId: "previous", projectId: 1 });
    const onSessionChange = mock(() => {});
    const onProjectChange = mock(() => {});
    const onSessionVisit = mock(() => {});

    store.setRoute = mock(async (sessionId: string | null) => {
      store.sessionId = sessionId ?? "";
      if (sessionId) store.projectId = 2;
    });

    const controller = new AppRouteController(fakeHost(), {
      store,
      onSessionChange,
      onProjectChange,
      onSessionVisit,
    });
    controller.connect();
    await Promise.resolve();

    globals.locationState.hash = "#/session/another";
    globals.hashChangeListener?.();
    await Promise.resolve();

    expect(localStorage.getItem("reins:last-hash")).toBe("#/session/another");
    expect(onSessionChange).toHaveBeenCalled();
    expect(onProjectChange).toHaveBeenCalled();
    expect(onSessionVisit).toHaveBeenCalledWith("another");
    globals.restore();
  });
});
