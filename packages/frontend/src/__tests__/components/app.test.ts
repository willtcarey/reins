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

describe("AppShell activity routing", () => {
  test("viewing a session routes the viewed transition through AppStore", async () => {
    Reflect.set(globalThis, "location", { protocol: "http:", host: "localhost:3000" });
    Reflect.set(globalThis, "window", { matchMedia: () => ({ matches: false }) });
    Reflect.set(globalThis, "navigator", { standalone: false });

    const el = new AppShell();
    const markActiveSessionViewed = mock(() => {});
    const refreshDiff = mock(() => {});
    const recordVisit = mock(() => {});

    const appStore = {
      projectId: 42,
      sessionId: "",
      setRoute: mock(async (sessionId: string | null) => {
        appStore.sessionId = sessionId ?? "";
      }),
      diffStore: { refresh: refreshDiff },
      markActiveSessionViewed,
    };

    Reflect.set(el, "appStore", appStore);
    Reflect.set(el, "quickOpenStore", { recordVisit });

    await Reflect.get(el, "applyRoute").call(el, { sessionId: "s1" });

    expect(markActiveSessionViewed).toHaveBeenCalledTimes(1);
  });
});
