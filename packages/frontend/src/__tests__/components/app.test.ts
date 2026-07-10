import { afterEach, describe, expect, mock, test } from "bun:test";
import { AppShell } from "../../components/app.js";
import { collectTemplateEventListeners, collectTemplateValues, templateToString } from "../helpers/lit-template.js";

const originalLocation = globalThis.location;
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

function fullTemplateOutput(value: unknown): string {
  const collected = collectTemplateValues(value);
  return `${templateToString(value)}\n${templateToString(collected)}`;
}

function pointerEvent(fields: {
  isPrimary?: boolean;
  target?: EventTarget | null;
  pointerId: number;
  clientX: number;
  clientY: number;
  timeStamp: number;
  currentTarget?: EventTarget | null;
  preventDefault?: () => void;
  composedPath?: () => EventTarget[];
}): PointerEvent {
  // @ts-expect-error The tests supply the PointerEvent fields AppShell's rendered handlers read.
  return fields;
}

function installAppShellGlobals(options: {
  mobile: boolean;
  frameCallbacks?: FrameRequestCallback[];
}) {
  Reflect.set(globalThis, "location", { protocol: "http:", host: "localhost:3000" });
  Reflect.set(globalThis, "navigator", { standalone: false });
  Reflect.set(globalThis, "window", {
    innerWidth: 390,
    matchMedia: () => ({ matches: options.mobile }),
    setTimeout(fn: () => void) { fn(); return 0; },
    requestAnimationFrame(callback: FrameRequestCallback) {
      options.frameCallbacks?.push(callback);
      return options.frameCallbacks?.length ?? 1;
    },
    cancelAnimationFrame() {},
  });
}

function installRenderableStore(el: AppShell) {
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
    installAppShellGlobals({ mobile: false });

    const el = new AppShell();
    installRenderableStore(el);
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
    installAppShellGlobals({ mobile: true });

    const el = new AppShell();
    installRenderableStore(el);
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

  test("updates the mobile workspace transform during a swipe and settles on the next pane", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    installAppShellGlobals({ mobile: true, frameCallbacks });
    const el = new AppShell();
    installRenderableStore(el);

    const rendered = el.render();
    const [pointerDown] = collectTemplateEventListeners(rendered, "pointerdown");
    const [pointerMove] = collectTemplateEventListeners(rendered, "pointermove");
    const [pointerUp] = collectTemplateEventListeners(rendered, "pointerup");
    expect(pointerDown).toBeDefined();
    expect(pointerMove).toBeDefined();
    expect(pointerUp).toBeDefined();

    pointerDown(pointerEvent({
      isPrimary: true,
      target: null,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      timeStamp: 0,
    }));
    pointerMove(pointerEvent({
      pointerId: 1,
      clientX: -180,
      clientY: 0,
      timeStamp: 16,
      currentTarget: null,
      preventDefault() {},
    }));

    expect(fullTemplateOutput(el.render()))
      .toContain("transform: translate3d(-570px, 0, 0);");

    pointerUp(pointerEvent({
      pointerId: 1,
      clientX: -220,
      clientY: 0,
      timeStamp: 48,
    }));

    for (let index = 0; index < frameCallbacks.length; index += 1) {
      frameCallbacks[index](index * 16);
      if (fullTemplateOutput(el.render()).includes("transform: translate3d(-200%, 0, 0);")) break;
    }

    expect(fullTemplateOutput(el.render()))
      .toContain("transform: translate3d(-200%, 0, 0);");
  });

  test("does not move the workspace from pointer drags on desktop", () => {
    installAppShellGlobals({ mobile: false });
    const el = new AppShell();
    installRenderableStore(el);

    const rendered = el.render();
    const [pointerDown] = collectTemplateEventListeners(rendered, "pointerdown");
    const [pointerMove] = collectTemplateEventListeners(rendered, "pointermove");
    let prevented = false;

    pointerDown(pointerEvent({
      isPrimary: true,
      target: null,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      timeStamp: 0,
    }));
    pointerMove(pointerEvent({
      pointerId: 1,
      clientX: -180,
      clientY: 0,
      timeStamp: 16,
      currentTarget: null,
      preventDefault() { prevented = true; },
    }));

    expect(prevented).toBe(false);
    expect(fullTemplateOutput(el.render()))
      .toContain("transform: translate3d(-100%, 0, 0);");
  });
});
