import { afterEach, describe, expect, mock, test } from "bun:test";
import { AppShell } from "../../components/app.js";

const originalLocation = globalThis.location;
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

afterEach(() => {
  Reflect.set(globalThis, "location", originalLocation);
  Reflect.set(globalThis, "window", originalWindow);
  Reflect.set(globalThis, "navigator", originalNavigator);
});

describe("AppShell visibility change", () => {
  test("calls active session markViewed when visibility becomes visible", async () => {
    Reflect.set(globalThis, "location", { protocol: "http:", host: "localhost:3000" });
    Reflect.set(globalThis, "window", { matchMedia: () => ({ matches: false }) });
    Reflect.set(globalThis, "navigator", { standalone: false });

    const el = new AppShell();
    const markViewed = mock(() => {});

    const appStore = {
      projectId: 42,
      sessionId: "s1",
      setRoute: mock(async () => {}),
      diffStore: { refresh: mock(() => {}) },
      activeSessionStore: { markViewed },
    };

    Reflect.set(el, "appStore", appStore);

    const prevDoc = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { visibilityState: "visible" },
      writable: true,
    });

    try {
      Reflect.get(el, "handleVisibilityChange").call(el);
      expect(markViewed).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: prevDoc,
        writable: true,
      });
    }
  });

  test("does not call active session markViewed when visibility is hidden", async () => {
    Reflect.set(globalThis, "location", { protocol: "http:", host: "localhost:3000" });
    Reflect.set(globalThis, "window", { matchMedia: () => ({ matches: false }) });
    Reflect.set(globalThis, "navigator", { standalone: false });

    const el = new AppShell();
    const markViewed = mock(() => {});

    const appStore = {
      projectId: 42,
      sessionId: "s1",
      setRoute: mock(async () => {}),
      diffStore: { refresh: mock(() => {}) },
      activeSessionStore: { markViewed },
    };

    Reflect.set(el, "appStore", appStore);

    const prevDoc = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { visibilityState: "hidden" },
      writable: true,
    });

    try {
      Reflect.get(el, "handleVisibilityChange").call(el);
      expect(markViewed).toHaveBeenCalledTimes(0);
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: prevDoc,
        writable: true,
      });
    }
  });
});

describe("AppShell activity routing", () => {
  test("switches to chat before route initialization finishes", async () => {
    Reflect.set(globalThis, "location", { protocol: "http:", host: "localhost:3000" });
    Reflect.set(globalThis, "window", { matchMedia: () => ({ matches: false }) });
    Reflect.set(globalThis, "navigator", { standalone: false });

    const el = new AppShell();
    Reflect.set(el, "activeTab", "changes");

    let resolveRoute!: () => void;
    const appStore = {
      projectId: 42,
      sessionId: "",
      setRoute: mock((sessionId: string | null) => {
        appStore.sessionId = sessionId ?? "";
        return new Promise<void>((resolve) => { resolveRoute = resolve; });
      }),
      diffStore: { refresh: mock(() => {}) },
      activeSessionStore: { markViewed: mock(() => {}) },
    };

    Reflect.set(el, "appStore", appStore);
    Reflect.set(el, "quickOpenStore", { recordVisit: mock(() => {}) });

    const routePromise = Reflect.get(el, "applyRoute").call(el, { sessionId: "s1" });
    await Promise.resolve();

    expect(Reflect.get(el, "activeTab")).toBe("chat");

    resolveRoute();
    await routePromise;
  });

  test("viewing a session records the quick-open visit", async () => {
    Reflect.set(globalThis, "location", { protocol: "http:", host: "localhost:3000" });
    Reflect.set(globalThis, "window", { matchMedia: () => ({ matches: false }) });
    Reflect.set(globalThis, "navigator", { standalone: false });

    const el = new AppShell();
    const recordVisit = mock(() => {});

    const appStore = {
      projectId: 42,
      sessionId: "",
      setRoute: mock(async (sessionId: string | null) => {
        appStore.sessionId = sessionId ?? "";
      }),
      activeSessionStore: { markViewed: mock(() => {}) },
    };

    Reflect.set(el, "appStore", appStore);
    Reflect.set(el, "quickOpenStore", { recordVisit });

    await Reflect.get(el, "applyRoute").call(el, { sessionId: "s1" });

    expect(recordVisit).toHaveBeenCalledWith("s1");
  });
});
