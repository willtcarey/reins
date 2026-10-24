import { afterEach, describe, expect, test } from "bun:test";
import { AppWorkspace } from "../../components/app-workspace.js";
import { DiffFileTree } from "../../components/changes/diff-file-tree.js";
import type { FileView } from "../../components/file-viewer/file-viewer.js";
import { Inspector } from "../../models/inspector.js";
import { DecoratorRegistry } from "../../sdk-host/decorators.js";
import { ViewRegistry } from "../../sdk-host/view-registry.js";
import { testElement } from "../helpers/test-dom.js";
import { collectTemplateEventListeners, collectTemplateProperties, collectTemplateValues, templateToString } from "../helpers/lit-template.js";

const source = { nodeId: "node", path: "/work/project" };
const readme: FileView = { view: "file", source, path: "README.md" };

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
  const projectId = options.projectId === undefined ? 42 : options.projectId;
  const views = new ViewRegistry();
  const inspector = new Inspector(views);
  const app = { views, decorators: new DecoratorRegistry(views), inspector };
  const store = {
    app,
    connected: true,
    projectId,
    source: projectId == null ? null : source,
    sessionId: options.sessionId ?? "s1",
    activeSessionStore: options.activeSessionStore === undefined
      ? { sessionData: { parentSessionId: null } }
      : options.activeSessionStore,
    activeProjectStore: { getSession: () => undefined, runningChildSessionsFor: () => [] },
    diffStore: { branch: "main" },
    codeReviewStore: {},
    projectsStore: { activityForSession() {} },
    inspector,
    subscribe() { return () => {}; },
  };
  Reflect.get(el, "storeController").store = store;
  return store;
}

/** Connects the workspace to its app, as connecting it to the page does. */
function connect(el: AppWorkspace) {
  Reflect.get(el, "connectApp").call(el);
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
    expect(output).toContain("<app-inspector");
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

  test("opens file search for the viewed session's source", () => {
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

    expect(scopes).toEqual([{ source: { nodeId: "node", path: "/work/project" } }]);
  });

  test("gives the chat panel the app's message decorators", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    const store = installRenderableStore(el);

    expect(collectTemplateProperties(el.render(), "decorators")).toEqual([store.app.decorators]);
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

  test("registers the diff file tree view while connected, mounting the tree over its stores", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    const store = installRenderableStore(el);
    connect(el);
    const pane = store.app.views.rendererFor({ view: "diff-file-tree" })?.pane;
    const target = testElement();

    pane?.mount(target, { view: "diff-file-tree" }, { source: store.source });
    const tree = target.childNodes[0];
    if (!(tree instanceof DiffFileTree)) throw new Error("Expected the diff file tree");

    expect(pane?.title({ view: "diff-file-tree" })).toBe("Changes");
    const stores: unknown[] = [tree.store, tree.reviewStore];
    expect(stores).toEqual([store.diffStore, store.codeReviewStore]);
    Reflect.get(el, "disconnectApp").call(el);
    expect(store.app.views.rendererFor({ view: "diff-file-tree" })).toBeNull();
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
    expect(output).toContain("<app-inspector");
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
    connect(el);

    store.app.inspector.open({ ...readme, startLine: 3 });

    expect(store.inspector.activeTab.view).toEqual({ ...readme, startLine: 3 });
    expect(fullTemplateOutput(el.render())).toContain("transform: translate3d(-100%, 0, 0);");
  });

  test("moves to the Inspector page when a view opens there on a phone", () => {
    installWorkspaceGlobals({ mobile: true });
    const el = new AppWorkspace();
    const store = installRenderableStore(el);
    connect(el);

    store.app.inspector.open(readme);

    expect(fullTemplateOutput(el.render())).toContain("transform: translate3d(-300%, 0, 0);");
  });

  test("on a phone, a swipe past the Inspector page focuses the next tab while the strip stays", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    installWorkspaceGlobals({ mobile: true, frameCallbacks });
    const el = new AppWorkspace();
    const store = installRenderableStore(el);
    connect(el);
    store.app.inspector.open(readme);
    store.inspector.focus("diff-file-tree");

    const rendered = el.render();
    const [pointerDown] = collectTemplateEventListeners(rendered, "pointerdown");
    const [pointerMove] = collectTemplateEventListeners(rendered, "pointermove");
    const [pointerUp] = collectTemplateEventListeners(rendered, "pointerup");
    pointerDown(pointerEvent({ isPrimary: true, target: null, pointerId: 1, clientX: 0, clientY: 0, timeStamp: 0 }));
    pointerMove(pointerEvent({ pointerId: 1, clientX: -176, clientY: 0, timeStamp: 16, currentTarget: null, preventDefault() {} }));
    const dragging = el.render();
    pointerUp(pointerEvent({ pointerId: 1, clientX: -220, clientY: 0, timeStamp: 48 }));
    for (let index = 0; index < frameCallbacks.length && index < 500; index += 1) frameCallbacks[index](index * 16);

    expect(fullTemplateOutput(dragging)).toContain("transform: translate3d(-1170px, 0, 0);");
    expect(collectTemplateProperties(dragging, "swipeX")).toEqual([-176]);
    expect(store.inspector.activeTab.key).toBe(store.inspector.tabs[1]!.key);
    expect(fullTemplateOutput(el.render())).toContain("transform: translate3d(-300%, 0, 0);");
  });
});
