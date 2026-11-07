import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PropertyValues } from "lit";
import { AppWorkspace } from "../../components/app-workspace.js";
import type { FileView } from "../../components/file-viewer/file-viewer.js";
import { AppStore } from "../../models/stores/app-store.js";
import type { SessionCache } from "../../models/stores/session-cache.js";
import { StubClient } from "../helpers/stub-client.js";
import { ViewMount } from "../../components/view-mount.js";
import { registerSessionViews } from "../../components/session-views.js";
import type { PaneContext, View } from "@reins/sdk";
import { registerInboxPage, type InboxView } from "../helpers/inbox-page.js";
import { paneContext } from "../helpers/reins-sdk.js";
import { setConnected, testDom } from "../helpers/test-dom.js";
import { collectKeyedKeys, collectTemplateEventListeners, collectTemplateProperties, collectTemplateValues, templateToString } from "../helpers/lit-template.js";

const source = { nodeId: "node", path: "/work/project" };
const readme: FileView = { view: "file", source, path: "README.md" };
const main: PaneContext = paneContext("main");

declare module "@reins/sdk" {
  interface ViewTypes {
    "test-sessions": { view: "test-sessions" };
  }
}

const originalLocation = globalThis.location;
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

function isPaneContext(value: unknown): value is PaneContext {
  return typeof value === "object" && value !== null && "subjectChanged" in value && typeof value.subjectChanged === "function";
}

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

/**
 * Gives the workspace a real app with the session's views registered, as app-shell registers them, showing `mainView`
 * (session s1's Chat by default). These template tests do not mount the views, so for a session it does what mounting
 * them would: places s1 in the workspace's checkout (`placeSession`) and pins the Inspector's Changes tab. `register` registers more views first.
 */
function installRenderableStore(el: AppWorkspace, options: { mainView?: View | null; register?: (app: AppStore) => void } = {}) {
  Reflect.set(el, "getBoundingClientRect", () => ({ width: 1200 }));
  const app = new AppStore(new StubClient());
  registerSessionViews(app.views, app);
  options.register?.(app);
  el.app = app;
  el.mainView = options.mainView !== undefined ? options.mainView : { view: "session", sessionId: "s1" };
  connect(el);
  const store = { app, inspector: app.inspector };
  if (el.mainView?.view === "session") {
    placeSession(store, "s1", 42);
    app.inspector.pin({ view: "diff-file-tree" });
  }
  return store;
}

/** Gives the app session `sessionId`'s details: in the workspace's checkout, of `projectId` and `taskId`. */
function placeSession(store: { app: { sessionCache: SessionCache } }, sessionId: string, projectId: number | null, taskId: number | null = null) {
  store.app.sessionCache.set(sessionId, {
    projectId, taskId, createdAt: "", updatedAt: "", messageCount: 0, state: { model: null, thinkingLevel: "off" },
    placement: { available: true, removed: false, nodeId: source.nodeId, nodeName: "Node", path: source.path },
  });
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
    installRenderableStore(el, { mainView: { view: "session", sessionId: "s2" } });
    const output = fullTemplateOutput(el.render());

    expect(output).toContain("data-workspace-shell");
    expect(output).toContain("<session-sidebar");
    expect(output).toContain("<app-main-toolbar");
    expect(output).not.toContain("No project selected");
  });


  test("renders the desktop layout on wider viewports", () => {
    installWorkspaceGlobals({ mobile: false });

    const el = new AppWorkspace();
    const store = installRenderableStore(el);
    // The Inspector is as wide as its shown tab asks.
    store.app.views.register("diff-file-tree", { pane: { title: () => "Changes", description: () => "Changed files", icon: { mount: () => {} }, mount: () => {}, width: 240 } });
    const rendered = el.render();
    const output = fullTemplateOutput(rendered);

    expect(output).toContain("data-workspace-shell");
    expect(output).toContain("overflow-clip swipe-shell");
    expect(output).toContain("workspace-surface");
    expect(output).toContain("md:!transform-none");
    expect(output).toContain("--workspace-left: 256px; --workspace-right: 240px");
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
    installRenderableStore(el);
    // The shown Chat is about s1, as its mount says.
    Reflect.set(el, "querySelector", () => ({ subject: () => [{ type: "session", id: "s1" }] }));
    const scopes: unknown[] = [];
    el.addEventListener("open-file-search", (event) => scopes.push(event.detail));

    const shortcut = new Event("keydown", { cancelable: true });
    Object.defineProperties(shortcut, {
      key: { value: "p" },
      metaKey: { value: true },
      ctrlKey: { value: false },
    });
    Reflect.get(el, "handleGlobalKeydown")(shortcut);
    installRenderableStore(el, { mainView: null });
    Reflect.get(el, "handleGlobalKeydown")(shortcut);

    expect(scopes).toEqual([{ source: { nodeId: "node", path: "/work/project" } }]);
  });

  test("mounts another session's tabs anew, as views of another identity, and keeps them while only the shown tab changes", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    installRenderableStore(el);

    const first = collectKeyedKeys(el.render());
    el.mainView = { view: "session-changes", sessionId: "s1" };
    const otherTab = collectKeyedKeys(el.render());
    el.mainView = { view: "session", sessionId: "s2" };
    const otherSession = collectKeyedKeys(el.render());

    expect(first).toHaveLength(2);
    expect(new Set(first).size).toBe(2);
    expect(otherTab).toEqual(first);
    expect(otherSession.filter((key) => first.includes(key))).toEqual([]);
  });

  test("shows a session as a tab for each of its views, each mounted in its own column, the shown one visible, and its toolbars marking their own", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    const store = installRenderableStore(el);
    const chat = { view: "session", sessionId: "s1" };

    const rendered = el.render();

    expect(collectTemplateProperties(rendered, "view")).toEqual([chat, { view: "session-changes", sessionId: "s1" }]);
    expect(collectTemplateProperties(rendered, "presentation")).toEqual([
      store.app.views.rendererFor(chat)?.pane,
      store.app.views.rendererFor({ view: "session-changes" })?.pane,
    ]);
    expect(collectTemplateProperties(rendered, "visible")).toEqual([true, false]);
    // The Inspector's tabs follow the toolbar's.
    expect(collectTemplateProperties(rendered, "tabs")[0]).toEqual([
      { view: chat, title: "Chat" },
      { view: { view: "session-changes", sessionId: "s1" }, title: "Changes" },
    ]);
  });

  test("on a wide screen, one toolbar stays over the tabs and marks the shown one, so its highlight moves to another", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    installRenderableStore(el);

    const onChat = el.render();
    el.mainView = { view: "session-changes", sessionId: "s1" };
    const onChanges = el.render();

    expect(collectTemplateProperties(onChat, "activeTab")).toEqual([0]);
    expect(collectTemplateProperties(onChanges, "activeTab")).toEqual([1]);
  });

  test("shows no Inspector, its resize handle or its page while it has no tabs", () => {
    for (const mobile of [false, true]) {
      installWorkspaceGlobals({ mobile });
      const page: InboxView = { view: "test-inbox", repository: "reins" };
      const el = new AppWorkspace();
      installRenderableStore(el, { register: registerInboxPage, mainView: page });

      const output = fullTemplateOutput(el.render());

      expect(output).not.toContain("<app-inspector");
      expect(output).not.toContain('data-resize-handle="inspector"');
      expect(output).toContain("--workspace-right: 0px");
      expect(output).toContain("grid-template-columns: repeat(2, 100%)");
    }
  });

  test("shows the Inspector beside a page once it has a tab", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    const store = installRenderableStore(el, { register: registerInboxPage, mainView: { view: "test-inbox", repository: "reins" } });

    store.app.inspector.open(readme);

    expect(fullTemplateOutput(el.render())).toContain("<app-inspector");
  });

  test("shows a view alone in the chat pane's place, its pane mounted there as in any container, under a phone's toolbar giving its title", () => {
    installWorkspaceGlobals({ mobile: true });
    const el = new AppWorkspace();
    const page: InboxView = { view: "test-inbox", repository: "reins" };
    const { app } = installRenderableStore(el, { register: registerInboxPage, mainView: page });

    const rendered = el.render();
    const output = fullTemplateOutput(rendered);

    expect(output).not.toContain("No project selected");
    expect(collectTemplateProperties(rendered, "presentation")).toEqual([app.views.rendererFor(page)?.pane]);
    expect(collectTemplateProperties(rendered, "view")).toEqual([page]);
    expect(collectTemplateProperties(rendered, "context")).toEqual([expect.objectContaining({ container: "main" })]);
    expect(collectTemplateProperties(rendered, "tabs")).toEqual([[]]);
    expect(collectTemplateProperties(rendered, "pageTitle")).toEqual(["Inbox · reins"]);
  });

  test("on a wide screen, gives a view shown alone the host's toolbar with its own toolbar, and no toolbar to a view without one", () => {
    installWorkspaceGlobals({ mobile: false });
    const page: InboxView = { view: "test-inbox", repository: "reins" };
    const rendered = (toolbar: boolean) => {
      const el = new AppWorkspace();
      const { app } = installRenderableStore(el, { register: (shown) => registerInboxPage(shown, { toolbar }), mainView: page });
      return { app, rendered: el.render() };
    };
    const withToolbar = rendered(true);

    expect(collectTemplateProperties(withToolbar.rendered, "viewToolbar")).toEqual([
      { presentation: withToolbar.app.views.rendererFor(page)?.pane?.toolbar, view: page, context: expect.objectContaining({ container: "main" }), key: withToolbar.app.views.keyOf(page) },
    ]);
    expect(collectTemplateProperties(rendered(false).rendered, "viewToolbar")).toEqual([]);
  });

  test("shows a page no renderer shows yet as unavailable, and mounts it once its renderer registers", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    const page: InboxView = { view: "test-inbox", repository: "reins" };
    const { app } = installRenderableStore(el, { mainView: page });

    const before = el.render();
    registerInboxPage(app);
    const after = el.render();

    expect(fullTemplateOutput(before)).toContain("Page unavailable");
    expect(collectTemplateProperties(before, "presentation")).toEqual([]);
    expect(fullTemplateOutput(after)).not.toContain("Page unavailable");
    expect(collectTemplateProperties(after, "presentation")).toEqual([app.views.rendererFor(page)?.pane]);
  });

  test("on a phone, brings the main area forward when its view changes", () => {
    installWorkspaceGlobals({ mobile: true });
    const el = new AppWorkspace();
    installRenderableStore(el, { mainView: null });
    Reflect.set(el, "activePane", "inspector");
    el.mainView = { view: "new-session", projectId: 7, taskId: null };
    const changed: PropertyValues<AppWorkspace> = new Map();
    changed.set("mainView", null);

    el.willUpdate(changed);

    expect(Reflect.get(el, "activePane")).toBe("main");
  });

  test("renders the mobile layout on mobile viewports, a toolbar on each tab's page marking its own", () => {
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
    expect(collectTemplateProperties(rendered, "activeTab")).toEqual([0, 1]);
    expect(output).not.toContain("show-connection-status");
    expect(output).toContain("<app-inspector");
    expect(output).not.toContain("Changed files");
    expect(output).not.toContain("<desktop-layout");
    expect(output).not.toContain("<mobile-layout");
  });

  test("updates the mobile workspace transform during a swipe and settles on the next tab, opening its view", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    installWorkspaceGlobals({ mobile: true, frameCallbacks });
    const el = new AppWorkspace();
    installRenderableStore(el);
    const opened: unknown[] = [];
    el.addEventListener("open-main-view", (event) => opened.push(event.detail));

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
    expect(opened).toEqual([{ view: "session-changes", sessionId: "s1" }]);
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

    expect(store.inspector.activeTab?.view).toEqual({ ...readme, startLine: 3 });
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
    expect(store.inspector.activeTab?.key).toBe(store.inspector.tabs[1]!.key);
    expect(fullTemplateOutput(el.render())).toContain("transform: translate3d(-300%, 0, 0);");
  });
});

describe("AppWorkspace as the main area's view (workspace.current)", () => {
  beforeEach(() => installWorkspaceGlobals({ mobile: false }));

  test("asks the mounted view shown what it is about", async () => {
    const el = new AppWorkspace();
    const page: InboxView = { view: "test-inbox", repository: "reins", projectId: 7 };
    const { app } = installRenderableStore(el, { register: registerInboxPage, mainView: page });
    const mount = testDom(new ViewMount());
    mount.presentation = app.views.rendererFor(page)?.pane ?? null;
    mount.view = page;
    mount.context = main;
    setConnected(mount, true);
    await mount.updateComplete;
    Reflect.set(el, "querySelector", (selector: string) => (selector === "reins-view-mount[data-main-shown]" ? mount : null));

    expect(el.current()).toEqual({ view: page, subject: [{ type: "project", id: 7 }] });
  });

  test("is about nothing while its view is not mounted yet", () => {
    const el = new AppWorkspace();
    const page: InboxView = { view: "test-inbox", repository: "reins" };
    installRenderableStore(el, { mainView: page });
    Reflect.set(el, "querySelector", () => null);

    expect(el.current()).toEqual({ view: page, subject: [] });
  });

  test("is no view when it shows none", () => {
    const el = new AppWorkspace();
    installRenderableStore(el, { mainView: null });

    expect(el.current()).toBeNull();
  });
});

describe("AppWorkspace telling the main area changed", () => {
  beforeEach(() => installWorkspaceGlobals({ mobile: false }));

  test("a view in the main area saying its subject changed is followed again, and the main area is told", async () => {
    let about = "s1";
    const view: View = { view: "test-sessions" };
    const el = new AppWorkspace();
    const { app } = installRenderableStore(el, {
      mainView: view,
      register: (shown) => shown.views.register("test-sessions", {
        pane: {
          title: () => "Sessions",
          description: () => "Sessions",
          icon: { mount: () => {} },
          mount: () => ({ subject: () => [{ type: "session", id: about }] }),
        },
      }),
    });
    const [context] = collectTemplateProperties(el.render(), "context");
    if (!isPaneContext(context)) throw new Error("Expected the main area's context");
    const mount = testDom(new ViewMount());
    mount.presentation = app.views.rendererFor(view)?.pane ?? null;
    mount.view = view;
    mount.context = context;
    setConnected(mount, true);
    await mount.updateComplete;
    Reflect.set(el, "querySelector", (selector: string) => (selector === "reins-view-mount[data-main-shown]" ? mount : null));
    let told = 0;
    el.addEventListener("main-view-change", () => { told += 1; });

    about = "s2";
    context.subjectChanged();
    await mount.updateComplete;
    await Promise.resolve();

    expect(el.current()?.subject).toEqual([{ type: "session", id: "s2" }]);
    expect(told).toBe(1);
  });

  test("an Inspector view saying its subject changed changes nothing", () => {
    const el = new AppWorkspace();
    installRenderableStore(el);
    const context = collectTemplateProperties(el.render(), "context").find((candidate) => isPaneContext(candidate) && candidate.container === "inspector");
    if (!isPaneContext(context)) throw new Error("Expected the Inspector's context");
    let told = 0;
    el.addEventListener("main-view-change", () => { told += 1; });

    context.subjectChanged();

    expect(told).toBe(0);
  });
});
