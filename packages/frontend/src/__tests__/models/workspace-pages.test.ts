import { expect, test } from "bun:test";
import { WorkspacePages } from "../../models/workspace-pages.js";
import type { FileView } from "../../components/file-viewer/file-viewer.js";
import { testInspector } from "../helpers/reins-sdk.js";

const source = { nodeId: "node", path: "/work" };
const readme: FileView = { view: "file", source, path: "README.md" };
const sessionTabs = { tabs: ["session", "session-changes"], active: "session" };

test("the sessions are a page, then each tab of the main area, then each of the Inspector's tabs", () => {
  const inspector = testInspector();
  inspector.open(readme);
  inspector.open({ view: "file", source, path: "src/index.ts" });
  inspector.focus(inspector.tabs[1]!.key);

  const pages = new WorkspacePages({ tabs: ["session", "session-changes"], active: "session-changes" }, inspector);

  expect(pages.pageOf("sessions")).toBe(0);
  expect(pages.pageOf("main")).toBe(2);
  expect(pages.pageOf("inspector")).toBe(4);
  expect(pages.count).toBe(6);
  expect(pages.at(1)).toEqual({ pane: "main", tab: "session" });
  expect(pages.at(2)).toEqual({ pane: "main", tab: "session-changes" });
});

test("a main area without tabs (a page, or nothing shown) is one page, and without an Inspector (no project) the Inspector is one page", () => {
  const pages = new WorkspacePages({ tabs: [], active: null }, null);

  expect(pages.count).toBe(3);
  expect(pages.pageOf("main")).toBe(1);
  expect(pages.at(1)).toEqual({ pane: "main", tab: null });
  expect(pages.at(2)).toEqual({ pane: "inspector", tab: null });
});

test("a page past the main area's tabs is the Inspector, with the tab to focus", () => {
  const inspector = testInspector();
  inspector.open(readme);

  inspector.focus("diff-file-tree");
  const pages = new WorkspacePages(sessionTabs, inspector);

  expect(pages.at(3)).toEqual({ pane: "inspector", tab: "diff-file-tree" });
  expect(pages.at(4)).toEqual({ pane: "inspector", tab: inspector.tabs[1]!.key });
  expect(pages.at(pages.pageOf("inspector") - 1)).toEqual({ pane: "main", tab: "session-changes" });
});

test("at rest, the surface stops at the Inspector's column and the Inspector shows its active tab", () => {
  const inspector = testInspector();
  inspector.open(readme);

  const pages = new WorkspacePages(sessionTabs, inspector);

  expect(pages.offsets(1, null, 390)).toEqual({ surface: "-100%", inspector: null });
  expect(pages.offsets(4, null, 390)).toEqual({ surface: "-300%", inspector: null });
});

test("a drag moves the surface up to the Inspector's column and the Inspector's tabs past it", () => {
  const inspector = testInspector();
  inspector.open(readme);

  const pages = new WorkspacePages(sessionTabs, inspector);

  expect(pages.offsets(2, -1000, 390)).toEqual({ surface: "-1000px", inspector: 0 });
  expect(pages.offsets(3, -1346, 390)).toEqual({ surface: "-1170px", inspector: -176 });
});

test("the Inspector's pages follow the main area's, however many tabs it has", () => {
  const inspector = testInspector();
  inspector.open(readme);

  const pages = new WorkspacePages({ tabs: [], active: null }, inspector);

  expect(pages.count).toBe(4);
  expect(pages.at(2)).toEqual({ pane: "inspector", tab: "diff-file-tree" });
  expect(pages.offsets(3, -1000, 390)).toEqual({ surface: "-780px", inspector: -220 });
});
