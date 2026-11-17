import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PaneContext, Source, View } from "@reins/sdk";
import { registerSessionViews, SessionChangesPane, SessionChatPane, SessionToolbar } from "../../components/session-views.js";
import { AppStore } from "../../models/stores/app-store.js";
import { collectTemplateEventListeners, collectTemplateProperties, collectTemplateValues, templateToString } from "../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { paneContext } from "../helpers/reins-sdk.js";
import { StubClient } from "../helpers/stub-client.js";
import { testElement } from "../helpers/test-dom.js";

declare module "@reins/sdk" {
  interface ViewTypes {
    "coordinator-work": { view: "coordinator-work"; sessionId: string };
    "coordinator-plan": { view: "coordinator-plan"; sessionId: string };
    "coordinator-board": { view: "coordinator-board"; sessionId: string };
  }
}

const source: Source = { nodeId: "node", path: "/work/project" };
const main: PaneContext = paneContext("main");
const agentViews = { pinned: ["diff-file-tree"], main: ["session", "session-changes"] };

function output(value: unknown): string {
  return `${templateToString(value)}\n${templateToString(collectTemplateValues(value))}`;
}

/** The app with the session's views registered, as app-shell registers them. */
function sessionApp() {
  const app = new AppStore(new StubClient());
  registerSessionViews(app.views, app);
  const mount = (view: View, context: PaneContext = main) => {
    const target = testElement();
    const mounted = app.views.rendererFor(view)?.pane?.mount(target, view, context) ?? undefined;
    return { mounted, pane: target.childNodes[0] };
  };
  /** Gives the app session `sessionId`'s details: in `source`, of `projectId` and `taskId`. */
  const place = (sessionId: string, projectId: number | null, taskId: number | null = null) => {
    app.sessionCache.set(sessionId, {
      projectId, taskId, createdAt: "", updatedAt: "", messageCount: 0, state: { model: null, thinkingLevel: "off" }, kind: "agent", views: agentViews,
      placement: { available: true, removed: false, nodeId: source.nodeId, nodeName: "Node", path: source.path },
    });
  };
  /** The diff of `sessionId` the app has now (a new entry when none uses it). */
  const diffOf = (sessionId: string) => {
    const { diff, release } = app.diffs.use(sessionId);
    release();
    return diff;
  };
  return { app, mount, place, diffOf };
}

beforeEach(() => mockFetch(() => new Response("", { status: 404 })));
afterEach(() => restoreFetch());

describe("the session's Chat", () => {
  test("draws the conversation of its own session's store, with the app's message decorators, and keeps it for a new open of the session", () => {
    const { app, mount } = sessionApp();

    const { mounted, pane } = mount({ view: "session", sessionId: "s1" });
    if (!(pane instanceof SessionChatPane)) throw new Error("Expected the session's chat");
    mounted?.setVisible?.(false);
    const first = pane.session;

    expect(first?.sessionId).toBe("s1");
    expect(output(pane.render())).toContain("<chat-panel");
    expect(collectTemplateProperties(pane.render(), "decorators")).toEqual([app.decorators]);
    expect(pane.visible).toBe(false);

    mounted?.update?.({ view: "session", sessionId: "s1" }, main);
    expect(pane.session).toBe(first);
  });

  test("is about the session, then its task and project once its details are known", () => {
    const { mount, place } = sessionApp();
    const { mounted } = mount({ view: "session", sessionId: "s1" });

    expect(mounted?.subject?.()).toEqual([{ type: "session", id: "s1" }]);
    place("s1", 7, 3);
    expect(mounted?.subject?.()).toEqual([{ type: "session", id: "s1" }, { type: "task", id: 3 }, { type: "project", id: 7 }]);
  });
});

describe("the session's Changes", () => {
  test("draws the review surface over the session's diff", () => {
    const { mount, place, diffOf } = sessionApp();
    place("s1", 42);

    const { pane } = mount({ view: "session-changes", sessionId: "s1" });
    if (!(pane instanceof SessionChangesPane)) throw new Error("Expected the session's changes");

    expect(output(pane.render())).toContain("<review-diff-panel");
    expect(collectTemplateProperties(pane.render(), "store")).toEqual([diffOf("s1").files]);
  });

  test("reveals the file it is opened at, each time it is opened at one", () => {
    const { mount, place } = sessionApp();
    place("s1", 42);
    const view: View = { view: "session-changes", sessionId: "s1", file: "src/a.ts" };

    const { mounted, pane } = mount(view);
    if (!(pane instanceof SessionChangesPane)) throw new Error("Expected the session's changes");
    const [first] = collectTemplateProperties(pane.render(), "reveal");
    mounted?.update?.({ ...view }, main);
    const [again] = collectTemplateProperties(pane.render(), "reveal");

    expect(first).toEqual({ path: "src/a.ts" });
    expect(again).toEqual({ path: "src/a.ts" });
    expect(again).not.toBe(first);
  });

  test("is about the session, then its task and project, from the session's details", () => {
    const { mount, place } = sessionApp();
    const { mounted } = mount({ view: "session-changes", sessionId: "s1" });

    expect(mounted?.subject?.()).toEqual([{ type: "session", id: "s1" }]);
    place("s1", 7, 3);
    expect(mounted?.subject?.()).toEqual([{ type: "session", id: "s1" }, { type: "task", id: 3 }, { type: "project", id: 7 }]);
  });

  test("is about the file its review is on first, and says so when the review moves to another", () => {
    const { mount, place } = sessionApp();
    place("s1", 42);
    let said = 0;
    const context: PaneContext = { ...main, subjectChanged: () => { said += 1; } };

    const { mounted, pane } = mount({ view: "session-changes", sessionId: "s1" }, context);
    if (!(pane instanceof SessionChangesPane)) throw new Error("Expected the session's changes");
    const reviewOn = (path: string) => {
      for (const listener of collectTemplateEventListeners(pane.render(), "active-file-change")) listener(new CustomEvent("active-file-change", { detail: path }));
    };
    expect(mounted?.subject?.()[0]).toEqual({ type: "session", id: "s1" });

    reviewOn("src/a.ts");
    reviewOn("src/b.ts");

    expect(said).toBe(2);
    expect(mounted?.subject?.()[0]).toEqual({ type: "file", id: { source, path: "src/b.ts" } });
  });
});

const pane = { title: () => "", description: () => "", icon: { mount: () => {} }, mount: () => {} };
const coordinatorViews = { pinned: ["coordinator-work"], main: [] };

/** The session app with the Changes tree and a coordinator's Work view, keyed by its session, registered. */
function kindsApp() {
  const session = sessionApp();
  session.app.views.register("diff-file-tree", { pane });
  session.app.views.register("coordinator-work", { key: (view) => String(view.sessionId), pane }, "coordinator");
  const kindOf = (sessionId: string, kind: string, views: { pinned: string[]; main: string[] }) => session.app.sessionCache.set(sessionId, { kind, views });
  const pinned = () => session.app.inspector.tabs.map((tab) => [tab.view, tab.pinned]);
  return { ...session, kindOf, pinned };
}

describe("a session's tabs", () => {
  test("of an agent are its Chat and Changes, keyed by the session, and pin the Inspector's Changes while its Chat is mounted", () => {
    const { app, mount, kindOf, pinned } = kindsApp();
    kindOf("s1", "agent", agentViews);

    const chat = mount({ view: "session", sessionId: "s1" }).mounted;

    expect(app.views.tabsFor({ view: "session", sessionId: "s1" })).toEqual([{ view: "session", sessionId: "s1" }, { view: "session-changes", sessionId: "s1" }]);
    expect(pinned()).toEqual([[{ view: "diff-file-tree", sessionId: "s1" }, true]]);
    chat?.dispose?.();
    expect(app.inspector.tabs).toEqual([]);
  });

  test("of a kind that pins its own view are the Chat alone, with its view pinned and not Changes, the tab of each session", () => {
    const { app, mount, kindOf, pinned } = kindsApp();
    kindOf("s1", "coord/coordinator", coordinatorViews);
    kindOf("s2", "coord/coordinator", coordinatorViews);

    const first = mount({ view: "session", sessionId: "s1" }).mounted;
    expect(app.views.tabsFor({ view: "session", sessionId: "s1" })).toEqual([{ view: "session", sessionId: "s1" }]);
    expect(pinned()).toEqual([[{ view: "coordinator-work", sessionId: "s1" }, true]]);

    first?.dispose?.();
    mount({ view: "session", sessionId: "s2" });
    expect(pinned()).toEqual([[{ view: "coordinator-work", sessionId: "s2" }, true]]);
  });

  test("of a kind that declares none, or that is not registered (no views), are the Chat alone, with nothing pinned", () => {
    const { app, mount, kindOf } = kindsApp();
    kindOf("s1", "task-generator", { pinned: [], main: [] });
    kindOf("s2", "gone/coordinator", { pinned: [], main: [] });

    mount({ view: "session", sessionId: "s1" });
    mount({ view: "session", sessionId: "s2" });

    expect(app.views.tabsFor({ view: "session", sessionId: "s1" })).toEqual([{ view: "session", sessionId: "s1" }]);
    expect(app.views.tabsFor({ view: "session", sessionId: "s2" })).toEqual([{ view: "session", sessionId: "s2" }]);
    expect(app.inspector.tabs).toEqual([]);
  });

  test("follow the kind once it arrives after the Chat mounted, as for a session not loaded yet", () => {
    const { app, mount, kindOf, pinned } = kindsApp();

    const chat = mount({ view: "session", sessionId: "s1" }).mounted;
    expect(app.views.tabsFor({ view: "session", sessionId: "s1" })).toEqual([{ view: "session", sessionId: "s1" }]);
    expect(app.inspector.tabs).toEqual([]);

    kindOf("s1", "agent", agentViews);
    expect(app.views.tabsFor({ view: "session", sessionId: "s1" })).toHaveLength(2);
    expect(pinned()).toEqual([[{ view: "diff-file-tree", sessionId: "s1" }, true]]);

    chat?.dispose?.();
    kindOf("s1", "agent", { pinned: [], main: [] });
    expect(app.inspector.tabs).toEqual([]);
  });

  test("leave out a view the browser has no renderer for, until it registers", () => {
    const { app, mount, kindOf, pinned } = kindsApp();
    kindOf("s1", "coord/coordinator", { pinned: ["coordinator-plan", "coordinator-work"], main: ["coordinator-board"] });

    mount({ view: "session", sessionId: "s1" });
    expect(pinned()).toEqual([[{ view: "coordinator-work", sessionId: "s1" }, true]]);
    expect(app.views.tabsFor({ view: "session", sessionId: "s1" })).toEqual([{ view: "session", sessionId: "s1" }]);

    app.views.register("coordinator-plan", { key: (view) => String(view.sessionId), pane }, "coordinator");
    app.views.register("coordinator-board", { tabOf: { type: "session", parameter: "sessionId" }, pane }, "coordinator");
    expect(pinned().map(([view]) => view)).toEqual([{ view: "coordinator-work", sessionId: "s1" }, { view: "coordinator-plan", sessionId: "s1" }]);
    expect(app.views.tabsFor({ view: "session", sessionId: "s1" })).toEqual([{ view: "session", sessionId: "s1" }, { view: "coordinator-board", sessionId: "s1" }]);
  });

  test("of a kind without Changes still show Changes opened by hand: the tree as a tab the user closes, the review as a tab beside the Chat", () => {
    const { app, mount, kindOf } = kindsApp();
    kindOf("s1", "coord/coordinator", coordinatorViews);
    mount({ view: "session", sessionId: "s1" });

    app.inspector.open({ view: "diff-file-tree" });
    const tree = app.inspector.tabs.find((tab) => tab.view.view === "diff-file-tree");
    const review = { view: "session-changes", sessionId: "s1", file: "src/a.ts" };

    expect(tree?.pinned).toBe(false);
    expect(app.views.tabsFor(review)).toEqual([{ view: "session", sessionId: "s1" }, review]);
    app.inspector.close(tree!.key);
    expect(app.inspector.tabs.map((tab) => tab.view.view)).toEqual(["coordinator-work"]);
  });
});

describe("a session's toolbar", () => {
  /** Mounts the toolbar of `view`, and gives what it draws and the source its files button opens. */
  function mountToolbar(app: AppStore, view: View) {
    const target = testElement();
    const mounted = app.views.rendererFor(view)?.pane?.toolbar?.mount(target, view, main);
    const toolbar = target.childNodes[0];
    if (!(toolbar instanceof SessionToolbar)) throw new Error("Expected the session's toolbar");
    const opened: unknown[] = [];
    toolbar.addEventListener("open-file-browser", (event) => opened.push(event instanceof CustomEvent ? event.detail : null));
    const browse = () => { for (const listener of collectTemplateEventListeners(toolbar.render(), "click")) listener(new Event("click")); };
    return { mounted, toolbar, drawn: () => output(toolbar.render()), browse, opened };
  }

  test("of a session with Changes shows its branch, from its diff", () => {
    const { app, place } = kindsApp();
    place("s1", 42);

    const { toolbar, drawn } = mountToolbar(app, { view: "session", sessionId: "s1" });

    expect(toolbar.diff?.sessionId).toBe("s1");
    expect(drawn()).toContain("<branch-indicator");
  });

  test("of a session without Changes has no branch and loads no diff, but browses its files; Changes opened by hand shows its branch", () => {
    const { app, place, kindOf } = kindsApp();
    place("s1", null);
    kindOf("s1", "coord/coordinator", coordinatorViews);

    const chat = mountToolbar(app, { view: "session", sessionId: "s1" });
    chat.browse();
    const changes = mountToolbar(app, { view: "session-changes", sessionId: "s1" });

    expect(chat.toolbar.diff).toBeNull();
    expect(chat.drawn()).not.toContain("<branch-indicator");
    expect(chat.opened).toEqual([{ source }]);
    expect(changes.toolbar.diff?.sessionId).toBe("s1");
    expect(changes.drawn()).toContain("<branch-indicator");
  });

  test("follows the session's kind when it arrives after the toolbar mounted, and lets the diff go when disposed", () => {
    const { app, kindOf } = kindsApp();

    const { mounted, toolbar } = mountToolbar(app, { view: "session", sessionId: "s1" });
    expect(toolbar.diff).toBeNull();

    kindOf("s1", "agent", agentViews);
    const diff = toolbar.diff;
    mounted?.dispose?.();

    expect(diff?.sessionId).toBe("s1");
    expect(app.diffs.use("s1").diff).not.toBe(diff);
  });
});
