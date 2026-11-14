import { describe, expect, test } from "bun:test";
import type { Source, View } from "@reins/sdk";
import { closeTabsOnSourceChange } from "../../models/inspector.js";
import { testInspector, testSdk } from "../helpers/reins-sdk.js";

const source: Source = { nodeId: "node", path: "/work" };
const changes: View = { view: "diff-file-tree" };
const readme: View = { view: "file", source, path: "README.md" };

describe("Inspector", () => {
  test("starts with no tabs and none active", () => {
    const inspector = testInspector();

    expect(inspector.tabs).toEqual([]);
    expect(inspector.activeTab).toBeNull();
  });

  test("opening a view adds a tab after the others and focuses it", () => {
    const inspector = testInspector();

    inspector.open(readme);
    inspector.open({ view: "file", source, path: "docs/TODO.md", startLine: 3 });

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([readme, { view: "file", source, path: "docs/TODO.md", startLine: 3 }]);
    expect(inspector.activeTab?.view).toEqual({ view: "file", source, path: "docs/TODO.md", startLine: 3 });
  });

  test("opening a file that is already open focuses its tab and replaces its view", () => {
    const inspector = testInspector();
    inspector.open({ view: "file", source, path: "src/app.ts", startLine: 10, endLine: 12, mode: "preview" });
    inspector.open(readme);

    inspector.open({ view: "file", source, path: "src/app.ts", startLine: 40 });

    expect(inspector.tabs).toHaveLength(2);
    expect(inspector.activeTab?.view).toEqual({ view: "file", source, path: "src/app.ts", startLine: 40 });
  });

  test("opening the same view again gives its tab the new view object, which shows it afresh", () => {
    const inspector = testInspector();
    inspector.open({ view: "file", source, path: "src/app.ts", startLine: 10 });
    const first = inspector.activeTab?.view;
    const again: View = { view: "file", source, path: "src/app.ts", startLine: 10 };

    inspector.open(again);

    expect(inspector.activeTab?.view).toBe(again);
    expect(inspector.activeTab?.view).not.toBe(first);
  });

  test("closing the active tab focuses the tab before it, or after it when it was first, or none when it was the last", () => {
    const inspector = testInspector();
    inspector.open({ view: "file", source, path: "a.ts" });
    inspector.open({ view: "file", source, path: "b.ts" });
    inspector.open({ view: "file", source, path: "c.ts" });

    inspector.close(inspector.tabs[2]!.key);
    expect(inspector.activeTab?.view).toEqual({ view: "file", source, path: "b.ts" });

    inspector.focus(inspector.tabs[0]!.key);
    inspector.close(inspector.tabs[0]!.key);
    expect(inspector.activeTab?.view).toEqual({ view: "file", source, path: "b.ts" });

    inspector.close(inspector.tabs[0]!.key);
    expect(inspector.tabs).toEqual([]);
    expect(inspector.activeTab).toBeNull();
  });

  test("closing a view closes its tab, found by the view's key; a pinned one stays", () => {
    const inspector = testInspector();
    inspector.pin(changes);
    inspector.open(readme);

    inspector.closeView({ view: "file", source, path: "README.md" });
    inspector.closeView(changes);
    inspector.closeView({ view: "file", source, path: "absent.ts" });

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([changes]);
  });

  test("closing a background tab keeps the focused one", () => {
    const inspector = testInspector();
    inspector.open({ view: "file", source, path: "a.ts" });
    inspector.open({ view: "file", source, path: "b.ts" });

    inspector.close(inspector.tabs[0]!.key);

    expect(inspector.activeTab?.view).toEqual({ view: "file", source, path: "b.ts" });
  });

  test("the same path in two sources is two tabs", () => {
    const inspector = testInspector();

    inspector.open(readme);
    inspector.open({ view: "file", source: { nodeId: "node", path: "/other" }, path: "README.md" });

    expect(inspector.tabs).toHaveLength(2);
  });

  describe("a pinned tab", () => {
    test("comes before the other tabs, and is focused only when it is the first tab", () => {
      const inspector = testInspector();
      inspector.pin(changes);
      expect(inspector.activeTab?.view).toEqual(changes);

      inspector.open(readme);
      const other = testInspector();
      other.open(readme);
      other.pin(changes);

      expect(inspector.tabs.map((tab) => tab.view)).toEqual([changes, readme]);
      expect(other.tabs.map((tab) => tab.view)).toEqual([changes, readme]);
      expect(other.activeTab?.view).toEqual(readme);
    });

    test("cannot be closed, and is closed when every pin of it is released", () => {
      const inspector = testInspector();
      inspector.open(readme);
      const unpinChat = inspector.pin(changes);
      const unpinReview = inspector.pin(changes);
      inspector.focus(inspector.tabs[0]!.key);

      expect(inspector.tabs[0]!.pinned).toBe(true);
      inspector.close(inspector.tabs[0]!.key);
      unpinChat();
      unpinChat();
      expect(inspector.tabs.map((tab) => tab.view)).toEqual([changes, readme]);

      unpinReview();
      expect(inspector.tabs.map((tab) => tab.view)).toEqual([readme]);
      expect(inspector.activeTab?.view).toEqual(readme);
    });

    test("pinned again at once, as when the main area changes session, keeps its focus", () => {
      const inspector = testInspector();
      const unpinOld = inspector.pin(changes);
      inspector.open(readme);
      inspector.focus(inspector.tabs[0]!.key);

      unpinOld();
      inspector.pin(changes);

      expect(inspector.tabs.map((tab) => tab.view)).toEqual([changes, readme]);
      expect(inspector.activeTab?.view).toEqual(changes);
    });

    test("pinned again after the user chose another tab leaves that tab focused", () => {
      const inspector = testInspector();
      const unpinOld = inspector.pin(changes);
      inspector.open(readme);
      inspector.focus(inspector.tabs[0]!.key);

      unpinOld();
      inspector.focus(inspector.tabs[0]!.key);
      inspector.pin(changes);

      expect(inspector.activeTab?.view).toEqual(readme);
    });

    test("opened like any view is focused and stays pinned", () => {
      const inspector = testInspector();
      inspector.pin(changes);
      inspector.open(readme);

      inspector.open(changes);

      expect(inspector.activeTab?.view).toEqual(changes);
      expect(inspector.tabs[0]!.pinned).toBe(true);
    });

    test("is not an open: open listeners do not hear it", () => {
      const inspector = testInspector();
      const opened: View[] = [];
      inspector.onOpen((view) => opened.push(view));

      inspector.pin(changes);

      expect(opened).toEqual([]);
    });
  });

  test("tells listeners about every change, and open listeners about each view opened", () => {
    const inspector = testInspector();
    let changed = 0;
    const opened: View[] = [];
    inspector.subscribe(() => { changed += 1; });
    inspector.onOpen((view) => opened.push(view));

    const unpin = inspector.pin(changes);
    inspector.open(readme);
    inspector.focus(inspector.tabs[0]!.key);
    inspector.close(inspector.tabs[1]!.key);
    unpin();

    expect(changed).toBe(5);
    expect(opened).toEqual([readme]);
  });

  test("closing the tabs that match keeps the pinned ones, and the focus moves to the first tab left", () => {
    const inspector = testInspector();
    inspector.pin(changes);
    inspector.open(readme);
    const todo: View = { view: "file", source, path: "docs/TODO.md" };
    inspector.open(todo);

    inspector.closeTabs(() => true);

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([changes]);
    expect(inspector.activeTab?.view).toEqual(changes);
  });
});

const main: Source = { nodeId: "node", path: "/work" };
const task: Source = { nodeId: "node", path: "/work/.worktrees/task-1" };
const file = (at: Source, path: string): View => ({ view: "file", source: at, path });
const shown = (sessionId: string) => ({ view: { view: "session", sessionId }, subject: [{ type: "session" as const, id: sessionId }] });

/** Sessions `a` and `b` on the main checkout, `t` on a task's worktree; the main area shows `a`. */
function setup() {
  const sdk = testSdk({ current: shown("a") });
  const place = (id: string, at: Source) =>
    sdk.sessions.set(id, { projectId: 1, placement: { available: true, removed: false, nodeId: at.nodeId, nodeName: "Node", path: at.path } });
  place("a", main);
  place("b", main);
  place("t", task);
  const inspector = testInspector();
  closeTabsOnSourceChange(sdk.reins.workspace, sdk.reins.sessions, inspector);
  return { sdk, inspector };
}

describe("Inspector tabs on a switch of source", () => {
  test("going to a session on another checkout closes the tabs open before, but not the pinned ones", async () => {
    const { sdk, inspector } = setup();
    await Bun.sleep(0);
    inspector.pin(changes);
    inspector.open(file(main, "README.md"));

    sdk.showMain(shown("t"));
    await Bun.sleep(0);

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([changes]);
  });

  test("going to another session on the same checkout, or to a page of no session, keeps them", async () => {
    const { sdk, inspector } = setup();
    await Bun.sleep(0);
    inspector.open(file(main, "README.md"));

    sdk.showMain(shown("b"));
    await Bun.sleep(0);
    sdk.showMain({ view: { view: "settings" }, subject: [] });
    await Bun.sleep(0);
    sdk.showMain(shown("a"));
    await Bun.sleep(0);

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([file(main, "README.md")]);
  });

  test("a tab opened for the new session as the switch happens stays", async () => {
    const { sdk, inspector } = setup();
    await Bun.sleep(0);
    inspector.open(file(main, "README.md"));

    sdk.showMain(shown("t"));
    inspector.open(file(task, "PLAN.md"));
    await Bun.sleep(0);

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([file(task, "PLAN.md")]);
  });
});
