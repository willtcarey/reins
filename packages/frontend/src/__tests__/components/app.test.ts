import { afterEach, describe, expect, mock, test } from "bun:test";
import { AppShell } from "../../components/app.js";
import { collectTemplateValues, templateToString } from "../helpers/lit-template.js";

const originalLocation = globalThis.location;
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isWorkspacePaneRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value)
    && "sessions" in value
    && "chat" in value
    && "changes" in value
    && "files" in value;
}

function workspacePaneOutput(values: unknown[]): string {
  const panes = values.find(isWorkspacePaneRecord);
  if (!panes) return "";

  const paneValues = Object.values(panes);
  const nestedValues = paneValues.flatMap((value) => [value, ...collectTemplateValues(value)]);
  const directiveTemplates = nestedValues
    .map((value) => isObject(value) ? Reflect.get(value, "values") : null)
    .filter(isUnknownArray)
    .map((directiveValues) => templateToString(directiveValues[1]))
    .join("\n");

  return `${templateToString(paneValues)}\n${directiveTemplates}`;
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
    const output = templateToString(rendered);
    const layoutValues = collectTemplateValues(rendered);
    const panesOutput = workspacePaneOutput(layoutValues);

    expect(output).toContain("<desktop-layout");
    expect(panesOutput).toContain("<session-sidebar");
    expect(panesOutput).toContain("<app-main-toolbar");
    expect(panesOutput).toContain("<diff-file-tree");
    expect(panesOutput).toContain("<chat-panel");
    expect(panesOutput).toContain("<diff-renderer-shell");
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
    const output = templateToString(rendered);
    const panesOutput = workspacePaneOutput(collectTemplateValues(rendered));

    expect(output).toContain("<mobile-layout");
    expect(panesOutput).toContain("<session-sidebar");
    expect(panesOutput).toContain("<app-main-toolbar");
    expect(output).not.toContain("show-connection-status");
    expect(panesOutput).toContain("<diff-file-tree");
    expect(output).not.toContain("<desktop-layout");
  });
});
