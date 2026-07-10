import { afterEach, describe, expect, mock, test } from "bun:test";
import { AppShell } from "../../components/app.js";
import { collectTemplateValues, templateToString } from "../helpers/lit-template.js";

const originalLocation = globalThis.location;
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

function fullTemplateOutput(value: unknown): string {
  const collected = collectTemplateValues(value);
  return `${templateToString(value)}\n${templateToString(collected)}`;
}

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

describe("AppShell layout selection", () => {
  test("renders the desktop layout on wider viewports", () => {
    Reflect.set(globalThis, "location", { protocol: "http:", host: "localhost:3000" });
    Reflect.set(globalThis, "window", { matchMedia: () => ({ matches: false }) });
    Reflect.set(globalThis, "navigator", { standalone: false });

    const el = new AppShell();
    Reflect.set(el, "appStore", {
      connected: true,
      projectId: 42,
      sessionId: "s1",
      activeSessionStore: {},
      activeProjectStore: {},
      settingsStore: { diffRenderer: "classic" },
      diffStore: { branch: "main" },
      projectsStore: { activityForSession() {} },
    });
    const rendered = el.render();
    const output = fullTemplateOutput(rendered);

    expect(output).toContain("data-workspace-shell");
    expect(output).toContain("overflow-clip swipe-shell");
    expect(output).toContain("workspace-surface");
    expect(output).toContain("md:!transform-none");
    expect(output).toContain("md:![grid-template-columns:auto_minmax(0,1fr)_15rem]");
    expect(output).not.toContain("swipe-shell md:grid");
    expect(output).not.toContain("md:grid-cols-[auto_minmax(0,1fr)_15rem]");
    expect(output).not.toContain("md:col-span-3");
    expect(output).toContain("grid-template-columns: repeat(4, 100%); transform: translate3d(-100%, 0, 0);");
    expect(output).not.toContain("data-page-swipe-region");
    expect(output).not.toContain("sidebar-close-request");
    expect(output).toContain("<session-sidebar");
    expect(output).toContain("<app-main-toolbar");
    expect(output).toContain("<diff-file-tree");
    expect(output).not.toContain("<desktop-layout");
    expect(output).not.toContain("<mobile-layout");
  });

  test("renders the mobile layout on mobile viewports", () => {
    Reflect.set(globalThis, "location", { protocol: "http:", host: "localhost:3000" });
    Reflect.set(globalThis, "window", { matchMedia: () => ({ matches: true }) });
    Reflect.set(globalThis, "navigator", { standalone: false });

    const el = new AppShell();
    Reflect.set(el, "appStore", {
      connected: true,
      projectId: 42,
      sessionId: "s1",
      activeSessionStore: {},
      activeProjectStore: {},
      settingsStore: { diffRenderer: "classic" },
      diffStore: { branch: "main" },
      projectsStore: { activityForSession() {} },
    });
    const rendered = el.render();
    const output = fullTemplateOutput(rendered);

    expect(output).toContain("data-workspace-shell");
    expect(output).toContain("overflow-clip swipe-shell");
    expect(output).toContain("workspace-surface");
    expect(output).toContain("grid-template-columns: repeat(4, 100%); transform: translate3d(-100%, 0, 0);");
    expect(output).toContain("<session-sidebar");
    expect(output).toContain("<app-main-toolbar");
    expect(output).toContain(".activePane=chat");
    expect(output).toContain(".activePane=changes");
    expect(output).not.toContain("show-connection-status");
    expect(output).toContain("<diff-file-tree");
    expect(output).not.toContain("Changed files");
    expect(output).not.toContain("<desktop-layout");
    expect(output).not.toContain("<mobile-layout");
  });
});
