import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PaneContext, Source, View } from "@reins/sdk";
import { registerSessionViews, SessionChangesPane, SessionChatPane } from "../../components/session-views.js";
import { AppStore } from "../../models/stores/app-store.js";
import { collectTemplateEventListeners, collectTemplateProperties, collectTemplateValues, templateToString } from "../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { paneContext } from "../helpers/reins-sdk.js";
import { StubClient } from "../helpers/stub-client.js";
import { testElement } from "../helpers/test-dom.js";

const source: Source = { nodeId: "node", path: "/work/project" };
const main: PaneContext = paneContext("main");

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
      projectId, taskId, createdAt: "", updatedAt: "", messageCount: 0, state: { model: null, thinkingLevel: "off" },
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
  test("draws the conversation of its own session's store, with the app's message decorators, and another session's once updated to it", () => {
    const { app, mount } = sessionApp();

    const { mounted, pane } = mount({ view: "session", sessionId: "s1" });
    if (!(pane instanceof SessionChatPane)) throw new Error("Expected the session's chat");
    mounted?.setVisible?.(false);
    const first = pane.session;

    expect(first?.sessionId).toBe("s1");
    expect(output(pane.render())).toContain("<chat-panel");
    expect(collectTemplateProperties(pane.render(), "decorators")).toEqual([app.decorators]);
    expect(pane.visible).toBe(false);

    mounted?.update?.({ view: "session", sessionId: "s2" }, main);
    expect(pane.session?.sessionId).toBe("s2");
    expect(pane.session).not.toBe(first);
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
  test("draws the review surface over the session's diff, and that of another session it is updated to", () => {
    const { mount, place, diffOf } = sessionApp();
    place("s1", 42);
    place("s2", 42);

    const { mounted, pane } = mount({ view: "session-changes", sessionId: "s1" });
    if (!(pane instanceof SessionChangesPane)) throw new Error("Expected the session's changes");

    expect(output(pane.render())).toContain("<review-diff-panel");
    expect(collectTemplateProperties(pane.render(), "store")).toEqual([diffOf("s1").files]);
    mounted?.update?.({ view: "session-changes", sessionId: "s2" }, main);
    expect(collectTemplateProperties(pane.render(), "store")).toEqual([diffOf("s2").files]);
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

describe("a session's tabs", () => {
  test("are its tabs, keyed by the session", () => {
    const { app } = sessionApp();

    expect(app.views.tabsFor({ view: "session", sessionId: "s1" })).toEqual([{ view: "session", sessionId: "s1" }, { view: "session-changes", sessionId: "s1" }]);
  });

  test("pin the Inspector's Changes tab while mounted, which closes once the last of them is disposed", () => {
    const { app, mount } = sessionApp();

    const chat = mount({ view: "session", sessionId: "s1" }).mounted;
    const changes = mount({ view: "session-changes", sessionId: "s1" }).mounted;
    chat?.update?.({ view: "session", sessionId: "s2" }, main);

    expect(app.inspector.tabs.map((tab) => [tab.view, tab.pinned])).toEqual([[{ view: "diff-file-tree" }, true]]);
    chat?.dispose?.();
    expect(app.inspector.tabs).toHaveLength(1);
    changes?.dispose?.();
    expect(app.inspector.tabs).toEqual([]);
  });
});
