import { afterEach, describe, expect, test } from "bun:test";
import { AppWorkspace } from "../../components/app-workspace.js";
import { collectTemplateProperties } from "../helpers/lit-template.js";
import { openInBrowserEvent, openViewEvent } from "../../components/events.js";
import { Inspector } from "../../models/inspector.js";
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
  // @ts-expect-error The tests supply the PointerEvent fields AppWorkspace's rendered handlers read.
  return fields;
}

function installWorkspaceGlobals(options: {
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

function installRenderableStore(el: AppWorkspace, options: {
  projectId?: number | null;
  sessionId?: string;
  activeSessionStore?: object | null;
} = {}) {
  Reflect.set(el, "getBoundingClientRect", () => ({ width: 1200 }));
  const store = {
    connected: true,
    projectId: options.projectId === undefined ? 42 : options.projectId,
    sessionId: options.sessionId ?? "s1",
    checkoutPath: "/work/project",
    activeSessionStore: options.activeSessionStore === undefined
      ? { sessionData: { parentSessionId: null } }
      : options.activeSessionStore,
    activeProjectStore: { getSession: () => undefined, runningChildSessionsFor: () => [] },
    diffStore: { branch: "main" },
    projectsStore: { activityForSession() {} },
    inspector: new Inspector(),
    fileModel: {},
    opened: new Array<unknown>(),
    open(view: unknown, openOptions: unknown) { this.opened.push({ view, options: openOptions }); },
    focusInspectorTab(key: string) { this.inspector.focus(key); },
    subscribe() { return () => {}; },
  };
  Reflect.get(el, "storeController").store = store;
  return store;
}

afterEach(() => {
  Reflect.set(globalThis, "location", originalLocation);
  Reflect.set(globalThis, "window", originalWindow);
  Reflect.set(globalThis, "navigator", originalNavigator);
});

describe("AppWorkspace layout selection", () => {
  test("keeps the workspace mounted while selected session project metadata loads", () => {
    installWorkspaceGlobals({ mobile: false });

    const el = new AppWorkspace();
    installRenderableStore(el, { projectId: null, sessionId: "s2" });
    const output = fullTemplateOutput(el.render());

    expect(output).toContain("data-workspace-shell");
    expect(output).toContain("<session-sidebar");
    expect(output).toContain("<app-main-toolbar");
    expect(output).not.toContain("No project selected");
  });


  test("renders the desktop layout on wider viewports", () => {
    installWorkspaceGlobals({ mobile: false });

    const el = new AppWorkspace();
    installRenderableStore(el);
    const rendered = el.render();
    const output = fullTemplateOutput(rendered);

    expect(output).toContain("data-workspace-shell");
    expect(output).toContain("overflow-clip swipe-shell");
    expect(output).toContain("workspace-surface");
    expect(output).toContain("md:!transform-none");
    expect(output).toContain("--workspace-left: 256px; --workspace-right: 320px");
    expect(output).toContain('data-resize-handle');
    expect(output).not.toContain("swipe-shell md:grid");
    expect(output).not.toContain("md:grid-cols-[auto_minmax(0,1fr)_15rem]");
    expect(output).not.toContain("md:col-span-3");
    expect(output).toContain("grid-template-columns: repeat(4, 100%); transform: translate3d(-100%, 0, 0);");
    expect(output).not.toContain("data-page-swipe-region");
    expect(output).not.toContain("sidebar-close-request");
    expect(output).toContain("<session-sidebar");
    expect(output).toContain("<app-main-toolbar");
    expect(output).toContain("<workspace-inspector");
    expect(output).not.toContain("<desktop-layout");
    expect(output).not.toContain("<mobile-layout");
  });

  test("resizes desktop panes by keyboard and pointer without changing mobile page order", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    installRenderableStore(el);
    const separator = collectTemplateEventListeners(el.render(), "keydown")[0];
    separator(Object.assign(new Event("keydown", { cancelable: true }), { key: "ArrowRight" }));
    expect(fullTemplateOutput(el.render())).toContain("--workspace-left: 266px");
    separator(Object.assign(new Event("keydown", { cancelable: true }), { key: "Home" }));
    expect(fullTemplateOutput(el.render())).toContain("--workspace-left: 256px");

    installWorkspaceGlobals({ mobile: true });
    const mobile = new AppWorkspace();
    installRenderableStore(mobile);
    const mobileSeparator = collectTemplateEventListeners(mobile.render(), "keydown")[0];
    mobileSeparator(Object.assign(new Event("keydown", { cancelable: true }), { key: "ArrowRight" }));
    expect(fullTemplateOutput(mobile.render())).toContain("grid-template-columns: repeat(4, 100%); transform: translate3d(-100%, 0, 0);");
    expect(fullTemplateOutput(mobile.render())).toContain("--workspace-left: 256px");
  });

  test("opens file search with explicit current project scope", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    installRenderableStore(el, { projectId: 42 });
    const scopes: unknown[] = [];
    el.addEventListener("open-file-search", (event) => scopes.push(event.detail));

    const shortcut = new Event("keydown", { cancelable: true });
    Object.defineProperties(shortcut, {
      key: { value: "p" },
      metaKey: { value: true },
      ctrlKey: { value: false },
    });
    Reflect.get(el, "handleGlobalKeydown")(shortcut);
    installRenderableStore(el, { projectId: null });
    Reflect.get(el, "handleGlobalKeydown")(shortcut);

    expect(scopes).toEqual([{ projectId: 42 }]);
  });

  test("renders the review surface directly as the Changes pane", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    installRenderableStore(el);
    const store = el.store;

    const output = fullTemplateOutput(Reflect.get(el, "renderChangesPane").call(el, store, true));

    expect(output).toContain("<review-diff-panel");
    expect(output).not.toContain("<diff-renderer-shell");
  });

  test("renders the mobile layout on mobile viewports", () => {
    installWorkspaceGlobals({ mobile: true });

    const el = new AppWorkspace();
    installRenderableStore(el);
    const rendered = el.render();
    const output = fullTemplateOutput(rendered);

    expect(output).toContain("data-workspace-shell");
    expect(output).toContain("overflow-clip swipe-shell");
    expect(output).toContain("workspace-surface");
    expect(output).toContain("grid-template-columns: repeat(4, 100%); transform: translate3d(-100%, 0, 0);");
    expect(output).toContain("<session-sidebar");
    expect(output).toContain("grid-template-columns: repeat(4, 100%)");
    expect(output).toContain("hidden md:block absolute");
    expect(output).toContain("<app-main-toolbar");
    expect(output).toContain(".activePane=chat");
    expect(output).toContain(".activePane=changes");
    expect(output).not.toContain("show-connection-status");
    expect(output).toContain("<workspace-inspector");
    expect(output).not.toContain("Changed files");
    expect(output).not.toContain("<desktop-layout");
    expect(output).not.toContain("<mobile-layout");
  });

  test("updates the mobile workspace transform during a swipe and settles on the next pane", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    installWorkspaceGlobals({ mobile: true, frameCallbacks });
    const el = new AppWorkspace();
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
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
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

  test("opens a view in the Inspector without leaving the main pane on desktop", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    const store = installRenderableStore(el);

    el.dispatchEvent(openViewEvent({ view: "file", path: "README.md", startLine: 3 }, { in: "inspector" }));

    expect(store.opened).toEqual([{ view: { view: "file", path: "README.md", startLine: 3 }, options: { in: "inspector" } }]);
    expect(fullTemplateOutput(el.render())).toContain("transform: translate3d(-100%, 0, 0);");
  });

  test("moves to the Inspector page when a view opens there on a phone", () => {
    installWorkspaceGlobals({ mobile: true });
    const el = new AppWorkspace();
    installRenderableStore(el);

    el.dispatchEvent(openViewEvent({ view: "file", path: "README.md" }, { in: "inspector" }));

    expect(fullTemplateOutput(el.render())).toContain("transform: translate3d(-300%, 0, 0);");
  });

  test("opens files of the workspace's project in the file browser", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    installRenderableStore(el, { projectId: 42 });
    const handleOpenInBrowser = Reflect.get(el, "handleOpenInBrowser");

    handleOpenInBrowser(openInBrowserEvent(7, "elsewhere.ts"));
    expect(Reflect.get(el, "fileBrowser")).toBeNull();

    handleOpenInBrowser(openInBrowserEvent(42, "src/index.ts", { startLine: 2, endLine: 4 }));
    expect(Reflect.get(el, "fileBrowser")).toEqual({
      path: "src/index.ts",
      initialView: "code",
      highlight: { id: 1, startLine: 2, endLine: 4 },
    });
  });

  function swipe(el: AppWorkspace, dx: number, frameCallbacks: FrameRequestCallback[], settledTransform?: string) {
    const rendered = el.render();
    const [pointerDown] = collectTemplateEventListeners(rendered, "pointerdown");
    const [pointerMove] = collectTemplateEventListeners(rendered, "pointermove");
    const [pointerUp] = collectTemplateEventListeners(rendered, "pointerup");
    pointerDown(pointerEvent({ isPrimary: true, target: null, pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 }));
    pointerMove(pointerEvent({ pointerId: 1, clientX: dx * 0.8, clientY: 0, timeStamp: 16, currentTarget: null, preventDefault() {} }));
    const dragging = el.render();
    pointerUp(pointerEvent({ pointerId: 1, clientX: dx, clientY: 0, timeStamp: 48 }));
    for (let index = 0; index < frameCallbacks.length && index < 500; index += 1) {
      frameCallbacks[index](index * 16);
      if (settledTransform && fullTemplateOutput(el.render()).includes(settledTransform)) break;
    }
    return dragging;
  }

  test("on a phone, swiping past the Inspector page goes through its tabs, the strip staying in place", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    installWorkspaceGlobals({ mobile: true, frameCallbacks });
    const el = new AppWorkspace();
    const store = installRenderableStore(el);
    store.inspector.open({ view: "file", path: "README.md" });
    el.dispatchEvent(openViewEvent({ view: "file", path: "README.md" }, { in: "inspector" }));
    store.inspector.focus("changes");
    expect(fullTemplateOutput(el.render())).toContain("transform: translate3d(-300%, 0, 0);");

    const dragging = swipe(el, -220, frameCallbacks);

    expect(fullTemplateOutput(dragging)).toContain("transform: translate3d(-1170px, 0, 0);");
    expect(collectTemplateProperties(dragging, "swipeX")).toEqual([-176]);
    expect(store.inspector.activeTab.key).toBe("file:README.md");
    expect(fullTemplateOutput(el.render())).toContain("transform: translate3d(-300%, 0, 0);");
    expect(collectTemplateProperties(el.render(), "swipeX")).toEqual([null]);
  });

  test("on a phone, swiping right from the Inspector's first tab returns to Changes", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    installWorkspaceGlobals({ mobile: true, frameCallbacks });
    const el = new AppWorkspace();
    const store = installRenderableStore(el);
    store.inspector.open({ view: "file", path: "README.md" });
    el.dispatchEvent(openViewEvent({ view: "file", path: "README.md" }, { in: "inspector" }));
    store.inspector.focus("changes");

    swipe(el, 220, frameCallbacks, "transform: translate3d(-200%, 0, 0);");

    expect(fullTemplateOutput(el.render())).toContain("transform: translate3d(-200%, 0, 0);");
  });
});
