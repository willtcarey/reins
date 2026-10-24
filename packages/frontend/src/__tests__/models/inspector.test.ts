import { describe, expect, test } from "bun:test";
import type { Source, View } from "@reins/sdk";
import { testInspector } from "../helpers/reins-sdk.js";

const source: Source = { nodeId: "node", path: "/work" };

describe("Inspector", () => {
  test("starts with the changes tab focused", () => {
    const inspector = testInspector();

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([{ view: "diff-file-tree" }]);
    expect(inspector.activeTab.view).toEqual({ view: "diff-file-tree" });
  });

  test("opening a view adds a tab after the others and focuses it", () => {
    const inspector = testInspector();

    inspector.open({ view: "file", source, path: "README.md" });
    inspector.open({ view: "file", source, path: "docs/TODO.md", startLine: 3 });

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([
      { view: "diff-file-tree" },
      { view: "file", source, path: "README.md" },
      { view: "file", source, path: "docs/TODO.md", startLine: 3 },
    ]);
    expect(inspector.activeTab.view).toEqual({ view: "file", source, path: "docs/TODO.md", startLine: 3 });
  });

  test("opening a file that is already open focuses its tab and replaces its view", () => {
    const inspector = testInspector();
    inspector.open({ view: "file", source, path: "src/app.ts", startLine: 10, endLine: 12, mode: "preview" });
    inspector.open({ view: "file", source, path: "README.md" });

    inspector.open({ view: "file", source, path: "src/app.ts", startLine: 40 });

    expect(inspector.tabs).toHaveLength(3);
    expect(inspector.activeTab.view).toEqual({ view: "file", source, path: "src/app.ts", startLine: 40 });
  });

  test("opening the same view again gives its tab the new view object, which shows it afresh", () => {
    const inspector = testInspector();
    inspector.open({ view: "file", source, path: "src/app.ts", startLine: 10 });
    const first = inspector.activeTab.view;
    const again = { view: "file" as const, source, path: "src/app.ts", startLine: 10 };

    inspector.open(again);

    expect(inspector.activeTab.view).toBe(again);
    expect(inspector.activeTab.view).not.toBe(first);
  });

  test("closing the active tab focuses the tab before it", () => {
    const inspector = testInspector();
    inspector.open({ view: "file", source, path: "a.ts" });
    inspector.open({ view: "file", source, path: "b.ts" });
    inspector.open({ view: "file", source, path: "c.ts" });
    inspector.focus(inspector.tabs[2]!.key);

    inspector.close(inspector.tabs[2]!.key);

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([
      { view: "diff-file-tree" },
      { view: "file", source, path: "a.ts" },
      { view: "file", source, path: "c.ts" },
    ]);
    expect(inspector.activeTab.view).toEqual({ view: "file", source, path: "a.ts" });
  });

  test("closing a background tab keeps the focused one", () => {
    const inspector = testInspector();
    inspector.open({ view: "file", source, path: "a.ts" });
    inspector.open({ view: "file", source, path: "b.ts" });

    inspector.close(inspector.tabs[1]!.key);

    expect(inspector.activeTab.view).toEqual({ view: "file", source, path: "b.ts" });
  });

  test("the changes tab cannot be closed", () => {
    const inspector = testInspector();
    const changes = inspector.tabs[0]!;

    expect(changes.closable).toBe(false);
    inspector.close(changes.key);

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([{ view: "diff-file-tree" }]);
  });

  test("the same path in two sources is two tabs", () => {
    const inspector = testInspector();

    inspector.open({ view: "file", source, path: "README.md" });
    inspector.open({ view: "file", source: { nodeId: "node", path: "/other" }, path: "README.md" });

    expect(inspector.tabs).toHaveLength(3);
  });

  test("tells listeners about every change, and open listeners about each view opened", () => {
    const inspector = testInspector();
    let changes = 0;
    const opened: View[] = [];
    inspector.subscribe(() => { changes += 1; });
    inspector.onOpen((view) => opened.push(view));
    const view: View = { view: "file", source, path: "README.md" };

    inspector.open(view);
    inspector.focus(inspector.tabs[0]!.key);
    inspector.close(inspector.tabs[1]!.key);

    expect(changes).toBe(3);
    expect(opened).toEqual([view]);
  });

  test("closes every closable tab when the viewed session's source changes to another", () => {
    const inspector = testInspector();
    inspector.open({ view: "file", source, path: "README.md" });
    inspector.setViewedSource(source);
    inspector.setViewedSource(null);
    inspector.setViewedSource({ ...source });

    expect(inspector.tabs).toHaveLength(2);

    inspector.setViewedSource({ nodeId: "node", path: "/other" });

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([{ view: "diff-file-tree" }]);
    expect(inspector.activeTab.view).toEqual({ view: "diff-file-tree" });
  });
});
