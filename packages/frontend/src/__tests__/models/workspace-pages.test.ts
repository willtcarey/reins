import { expect, test } from "bun:test";
import { Inspector } from "../../models/inspector.js";
import { MOBILE_WORKSPACE_PANE_ORDER, WorkspacePages } from "../../models/workspace-pages.js";
import { viewKey, type ViewOf } from "../../reins-sdk/contract.js";

const source = { nodeId: "node", path: "/work" };
const readme: ViewOf<"file"> = { view: "file", source, path: "README.md" };

test("each pane before the Inspector is a page, and the Inspector's page is its active tab's", () => {
  const inspector = new Inspector();
  inspector.open(readme);
  inspector.open({ view: "file", source, path: "src/index.ts" });
  inspector.focus(viewKey(readme));

  const pages = new WorkspacePages(MOBILE_WORKSPACE_PANE_ORDER, inspector);

  expect(pages.pageOf("sessions")).toBe(0);
  expect(pages.pageOf("chat")).toBe(1);
  expect(pages.pageOf("changes")).toBe(2);
  expect(pages.pageOf("inspector")).toBe(4);
  expect(pages.count).toBe(6);
});

test("without an Inspector (no project), the Inspector is one page", () => {
  const pages = new WorkspacePages(MOBILE_WORKSPACE_PANE_ORDER, null);

  expect(pages.count).toBe(4);
  expect(pages.pageOf("inspector")).toBe(3);
  expect(pages.at(3)).toEqual({ pane: "inspector", tab: null });
});

test("a page past Changes is the Inspector, with the tab to focus", () => {
  const inspector = new Inspector();
  inspector.open(readme);

  const pages = new WorkspacePages(MOBILE_WORKSPACE_PANE_ORDER, inspector);

  expect(pages.at(3)).toEqual({ pane: "inspector", tab: "diff-file-tree" });
  expect(pages.at(4)).toEqual({ pane: "inspector", tab: viewKey(readme) });
});

test("the page before the Inspector's first tab is Changes", () => {
  const inspector = new Inspector();
  inspector.open(readme);
  inspector.focus("diff-file-tree");

  const pages = new WorkspacePages(MOBILE_WORKSPACE_PANE_ORDER, inspector);

  expect(pages.at(pages.pageOf("inspector") - 1)).toEqual({ pane: "changes", tab: null });
});

test("at rest, the surface stops at the Inspector's column and the Inspector shows its active tab", () => {
  const inspector = new Inspector();
  inspector.open(readme);

  const pages = new WorkspacePages(MOBILE_WORKSPACE_PANE_ORDER, inspector);

  expect(pages.offsets(1, null, 390)).toEqual({ surface: "-100%", inspector: null });
  expect(pages.offsets(4, null, 390)).toEqual({ surface: "-300%", inspector: null });
});

test("a drag moves the surface up to the Inspector's column and the Inspector's tabs past it", () => {
  const inspector = new Inspector();
  inspector.open(readme);

  const pages = new WorkspacePages(MOBILE_WORKSPACE_PANE_ORDER, inspector);

  expect(pages.offsets(2, -1000, 390)).toEqual({ surface: "-1000px", inspector: 0 });
  expect(pages.offsets(3, -1346, 390)).toEqual({ surface: "-1170px", inspector: -176 });
});

test("the Inspector's pages follow its place in the order", () => {
  const inspector = new Inspector();
  inspector.open(readme);

  const pages = new WorkspacePages(["sessions", "chat", "inspector"], inspector);

  expect(pages.count).toBe(4);
  expect(pages.at(2)).toEqual({ pane: "inspector", tab: "diff-file-tree" });
  expect(pages.at(1)).toEqual({ pane: "chat", tab: null });
  expect(pages.offsets(3, -1000, 390)).toEqual({ surface: "-780px", inspector: -220 });
});
