import { describe, expect, test } from "bun:test";
import { Inspector } from "../../models/inspector.js";

describe("Inspector", () => {
  test("starts with the changes tab focused", () => {
    const inspector = new Inspector();

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([{ view: "changes" }]);
    expect(inspector.activeTab.view).toEqual({ view: "changes" });
  });

  test("opening a view adds a tab after the others and focuses it", () => {
    const inspector = new Inspector();

    inspector.open({ view: "file", path: "README.md" });
    inspector.open({ view: "file", path: "docs/TODO.md", startLine: 3 });

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([
      { view: "changes" },
      { view: "file", path: "README.md" },
      { view: "file", path: "docs/TODO.md", startLine: 3 },
    ]);
    expect(inspector.activeTab.view).toEqual({ view: "file", path: "docs/TODO.md", startLine: 3 });
  });

  test("opening a file that is already open focuses its tab and replaces its view", () => {
    const inspector = new Inspector();
    inspector.open({ view: "file", path: "src/app.ts", startLine: 10, endLine: 12, mode: "preview" });
    inspector.open({ view: "file", path: "README.md" });

    inspector.open({ view: "file", path: "src/app.ts", startLine: 40 });

    expect(inspector.tabs).toHaveLength(3);
    expect(inspector.activeTab.view).toEqual({ view: "file", path: "src/app.ts", startLine: 40 });
  });

  test("opening the same view again gives its tab the new view object, which shows it afresh", () => {
    const inspector = new Inspector();
    inspector.open({ view: "file", path: "src/app.ts", startLine: 10 });
    const first = inspector.activeTab.view;
    const again = { view: "file" as const, path: "src/app.ts", startLine: 10 };

    inspector.open(again);

    expect(inspector.activeTab.view).toBe(again);
    expect(inspector.activeTab.view).not.toBe(first);
  });

  test("closing the active tab focuses the tab before it", () => {
    const inspector = new Inspector();
    inspector.open({ view: "file", path: "a.ts" });
    inspector.open({ view: "file", path: "b.ts" });
    inspector.open({ view: "file", path: "c.ts" });
    inspector.focus(inspector.tabs[2]!.key);

    inspector.close(inspector.tabs[2]!.key);

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([
      { view: "changes" },
      { view: "file", path: "a.ts" },
      { view: "file", path: "c.ts" },
    ]);
    expect(inspector.activeTab.view).toEqual({ view: "file", path: "a.ts" });
  });

  test("closing a background tab keeps the focused one", () => {
    const inspector = new Inspector();
    inspector.open({ view: "file", path: "a.ts" });
    inspector.open({ view: "file", path: "b.ts" });

    inspector.close(inspector.tabs[1]!.key);

    expect(inspector.activeTab.view).toEqual({ view: "file", path: "b.ts" });
  });

  test("the changes tab cannot be closed", () => {
    const inspector = new Inspector();
    const changes = inspector.tabs[0]!;

    expect(changes.closable).toBe(false);
    inspector.close(changes.key);

    expect(inspector.tabs.map((tab) => tab.view)).toEqual([{ view: "changes" }]);
  });
});
