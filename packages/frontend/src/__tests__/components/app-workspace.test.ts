import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PropertyValues } from "lit";
import { AppWorkspace } from "../../components/app-workspace.js";
import { DiffFileTree } from "../../components/changes/diff-file-tree.js";
import type { FileView } from "../../components/file-viewer/file-viewer.js";
import { Inspector } from "../../models/inspector.js";
import { DecoratorRegistry } from "../../sdk-host/decorators.js";
import { ViewRegistry } from "../../sdk-host/view-registry.js";
import { ViewMount } from "../../components/view-mount.js";
import { SessionChangesPane, SessionChatPane } from "../../components/session-views.js";
import type { PaneContext, View } from "@reins/sdk";
import { registerInboxPage, type InboxView } from "../helpers/inbox-page.js";
import { testSdk } from "../helpers/reins-sdk.js";
import { setConnected, testDom, testElement } from "../helpers/test-dom.js";
import { collectTemplateEventListeners, collectTemplateProperties, collectTemplateValues, templateToString } from "../helpers/lit-template.js";

const source = { nodeId: "node", path: "/work/project" };
const readme: FileView = { view: "file", source, path: "README.md" };
const main: PaneContext = { source, container: "main" };

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
  views?: ViewRegistry;
  mainView?: View | null;
} = {}) {
  Reflect.set(el, "getBoundingClientRect", () => ({ width: 1200 }));
  const projectId = options.projectId === undefined ? 42 : options.projectId;
  const views = options.views ?? new ViewRegistry();
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
    /** The sessions the workspace asked the store to follow. */
    followed: Array<string | null>(),
    async setSession(sessionId: string | null) { this.followed.push(sessionId); },
    subscribe() { return () => {}; },
  };
  Reflect.get(el, "storeController").store = store;
  // The main area shows the session's Chat, as its route does, unless there is no session.
  el.mainView = options.mainView !== undefined ? options.mainView : store.activeSessionStore ? { view: "session", sessionId: store.sessionId } : null;
  connect(el);
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

  test("the session's Chat tab draws its conversation over the workspace's store, with the app's message decorators", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    const store = installRenderableStore(el);
    const view = { view: "session", sessionId: "s1" };
    const target = testElement();

    const mounted = store.app.views.rendererFor(view)?.pane?.mount(target, view, main);
    const pane = target.childNodes[0];
    if (!(pane instanceof SessionChatPane)) throw new Error("Expected the session's chat");
    mounted?.setVisible?.(false);

    expect(fullTemplateOutput(pane.render())).toContain("<chat-panel");
    expect(collectTemplateProperties(pane.render(), "decorators")).toEqual([store.app.decorators]);
    expect(pane.visible).toBe(false);
  });

  test("the session's Changes tab draws the review surface of the session's project", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    const store = installRenderableStore(el);
    const view = { view: "session-changes", sessionId: "s1" };
    const target = testElement();

    store.app.views.rendererFor(view)?.pane?.mount(target, view, main);
    const pane = target.childNodes[0];
    if (!(pane instanceof SessionChangesPane)) throw new Error("Expected the session's changes");

    expect(fullTemplateOutput(pane.render())).toContain("<review-diff-panel");
  });

  test("shows a view alone in the chat pane's place, its pane mounted there as in any container, under a phone's toolbar giving its title", () => {
    installWorkspaceGlobals({ mobile: true });
    const { reins, views } = testSdk();
    registerInboxPage(reins);
    const el = new AppWorkspace();
    const page: InboxView = { view: "test-inbox", repository: "reins" };
    installRenderableStore(el, { projectId: null, activeSessionStore: null, views, mainView: page });

    const rendered = el.render();
    const output = fullTemplateOutput(rendered);

    expect(output).not.toContain("No project selected");
    expect(collectTemplateProperties(rendered, "presentation")).toEqual([views.rendererFor(page)?.pane]);
    expect(collectTemplateProperties(rendered, "view")).toEqual([page]);
    expect(collectTemplateProperties(rendered, "context")).toEqual([{ source: null, container: "main" }]);
    expect(collectTemplateProperties(rendered, "tabs")).toEqual([[]]);
    expect(collectTemplateProperties(rendered, "pageTitle")).toEqual(["Inbox · reins"]);
  });

  test("on a wide screen, gives a view shown alone the host's toolbar with its own toolbar, and no toolbar to a view without one", () => {
    installWorkspaceGlobals({ mobile: false });
    const withToolbar = testSdk();
    registerInboxPage(withToolbar.reins, { toolbar: true });
    const withoutToolbar = testSdk();
    registerInboxPage(withoutToolbar.reins);
    const page: InboxView = { view: "test-inbox", repository: "reins" };
    const rendered = (views: ViewRegistry) => {
      const el = new AppWorkspace();
      installRenderableStore(el, { projectId: null, activeSessionStore: null, views, mainView: page });
      return el.render();
    };

    expect(collectTemplateProperties(rendered(withToolbar.views), "viewToolbar")).toEqual([
      { presentation: withToolbar.views.rendererFor(page)?.pane?.toolbar, view: page, context: { source: null, container: "main" } },
    ]);
    expect(collectTemplateProperties(rendered(withoutToolbar.views), "viewToolbar")).toEqual([]);
  });

  test("shows a page no renderer shows yet as unavailable, and mounts it once its renderer registers", () => {
    installWorkspaceGlobals({ mobile: false });
    const { reins, views } = testSdk();
    const el = new AppWorkspace();
    const page: InboxView = { view: "test-inbox", repository: "reins" };
    installRenderableStore(el, { projectId: null, activeSessionStore: null, views, mainView: page });

    const before = el.render();
    registerInboxPage(reins);
    const after = el.render();

    expect(fullTemplateOutput(before)).toContain("Page unavailable");
    expect(collectTemplateProperties(before, "presentation")).toEqual([]);
    expect(fullTemplateOutput(after)).not.toContain("Page unavailable");
    expect(collectTemplateProperties(after, "presentation")).toEqual([views.rendererFor(page)?.pane]);
  });

  test("on a phone, brings the main area forward when its view changes", () => {
    installWorkspaceGlobals({ mobile: true });
    const el = new AppWorkspace();
    installRenderableStore(el, { projectId: null, activeSessionStore: null });
    Reflect.set(el, "activePane", "inspector");
    el.mainView = { view: "new-session", projectId: 7, taskId: null };
    const changed: PropertyValues<AppWorkspace> = new Map();
    changed.set("mainView", null);

    el.willUpdate(changed);

    expect(Reflect.get(el, "activePane")).toBe("main");
  });

  test("registers the diff file tree view while connected, mounting the tree over its stores", () => {
    installWorkspaceGlobals({ mobile: false });
    const el = new AppWorkspace();
    const store = installRenderableStore(el);
    connect(el);
    const pane = store.app.views.rendererFor({ view: "diff-file-tree" })?.pane;
    const target = testElement();

    pane?.mount(target, { view: "diff-file-tree" }, { source: store.source, container: "inspector" });
    const tree = target.childNodes[0];
    if (!(tree instanceof DiffFileTree)) throw new Error("Expected the diff file tree");

    expect(pane?.title({ view: "diff-file-tree" }, { source: store.source, container: "inspector" })).toBe("Changes");
    const stores: unknown[] = [tree.store, tree.reviewStore];
    expect(stores).toEqual([store.diffStore, store.codeReviewStore]);
    Reflect.get(el, "disconnectApp").call(el);
    expect(store.app.views.rendererFor({ view: "diff-file-tree" })).toBeNull();
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

describe("AppWorkspace as the main area's view (workspace.current)", () => {
  beforeEach(() => installWorkspaceGlobals({ mobile: false }));

  /** What the session's `view` says it is about, mounted over a workspace whose active session store is `active`. */
  function subjectOfSession(active: object | null, view: View = { view: "session", sessionId: "s1" }) {
    const el = new AppWorkspace();
    const store = installRenderableStore(el, { activeSessionStore: active });
    return store.app.views.rendererFor(view)?.pane?.mount(testElement(), view, main)?.subject?.();
  }

  test("a session's tabs are about the session, then its task, then its project", () => {
    expect(subjectOfSession({ sessionId: "s1", projectId: 7, sessionData: { taskId: 3, parentSessionId: null } }))
      .toEqual([{ type: "session", id: "s1" }, { type: "task", id: 3 }, { type: "project", id: 7 }]);
    expect(subjectOfSession({ sessionId: "s1", projectId: 7, sessionData: { taskId: null, parentSessionId: null } }, { view: "session-changes", sessionId: "s1" }))
      .toEqual([{ type: "session", id: "s1" }, { type: "project", id: 7 }]);
  });

  test("a session's tabs are about only the session while its details load, or while the store is still another session's", () => {
    expect(subjectOfSession({ sessionId: "s1", projectId: null, sessionData: { taskId: null, parentSessionId: null } })).toEqual([{ type: "session", id: "s1" }]);
    expect(subjectOfSession({ sessionId: "s0", projectId: 7, sessionData: { taskId: 3, parentSessionId: null } })).toEqual([{ type: "session", id: "s1" }]);
  });

  test("asks the mounted view shown what it is about", async () => {
    const { reins, views } = testSdk();
    registerInboxPage(reins);
    const el = new AppWorkspace();
    const page: InboxView = { view: "test-inbox", repository: "reins", projectId: 7 };
    installRenderableStore(el, { activeSessionStore: null, views, mainView: page });
    const mount = testDom(new ViewMount());
    mount.presentation = views.rendererFor(page)?.pane ?? null;
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
    installRenderableStore(el, { activeSessionStore: null, mainView: page });
    Reflect.set(el, "querySelector", () => null);

    expect(el.current()).toEqual({ view: page, subject: [] });
  });

  test("is no view when it shows none", () => {
    const el = new AppWorkspace();
    installRenderableStore(el, { activeSessionStore: null });

    expect(el.current()).toBeNull();
  });
});

describe("AppWorkspace's session (the Inspector's source, the diff and the review)", () => {
  beforeEach(() => installWorkspaceGlobals({ mobile: false }));

  /** The workspace showing `view`, mounted as the page would mount it, about what its renderer says. */
  async function showing(view: View, register?: (reins: ReturnType<typeof testSdk>["reins"]) => void) {
    const { reins, views } = testSdk();
    register?.(reins);
    const el = new AppWorkspace();
    const store = installRenderableStore(el, { activeSessionStore: null, views, mainView: view });
    const mount = testDom(new ViewMount());
    mount.presentation = views.rendererFor(view)?.pane ?? null;
    mount.view = view;
    mount.context = main;
    setConnected(mount, true);
    await mount.updateComplete;
    Reflect.set(el, "querySelector", (selector: string) => (selector === "reins-view-mount[data-main-shown]" ? mount : null));
    store.followed.length = 0;
    await Reflect.get(el, "followShownView").call(el);
    return store.followed;
  }

  test("follows the session the view shown is about, as its subject says", async () => {
    expect(await showing({ view: "session-changes", sessionId: "s2" })).toEqual(["s2"]);
  });

  test("follows no session while the view shown is about none", async () => {
    expect(await showing({ view: "test-inbox", repository: "reins", projectId: 7 }, (reins) => registerInboxPage(reins))).toEqual([null]);
  });
});

