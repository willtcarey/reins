import { describe, expect, test } from "bun:test";
import { AppInspector } from "../../components/app-inspector.js";
import type { FileView } from "../../components/file-viewer/file-viewer.js";
import type { Inspector } from "../../models/inspector.js";
import { ViewRegistry } from "../../sdk-host/view-registry.js";
import { clickButton, collectTemplateProperties, templateToString } from "../helpers/lit-template.js";
import { testInspector } from "../helpers/reins-sdk.js";

const source = { nodeId: "node", path: "/work" };
const plan: FileView = { view: "file", source, path: "docs/plan.md" };

const filePane = {
  title: (view: FileView) => view.path.slice(view.path.lastIndexOf("/") + 1),
  description: (view: FileView) => view.path,
  icon: { mount: () => {} },
  mount: () => {},
};

const treePane = { title: () => "Changes", description: () => "Changed files", icon: { mount: () => {} }, mount: () => {} };

function inspectorElement(inspector: Inspector): AppInspector {
  const views = new ViewRegistry();
  views.register("diff-file-tree", { pane: treePane });
  views.register("file", { pane: filePane });
  const element = new AppInspector();
  element.tabs = inspector.tabs;
  element.activeKey = inspector.activeTab.key;
  element.views = views;
  element.context = { source };
  return element;
}

describe("AppInspector", () => {
  test("offers closing every tab but the diff file tree's", () => {
    const inspector = testInspector();
    inspector.open(plan);
    const element = inspectorElement(inspector);
    const closed: string[] = [];
    element.addEventListener("inspector-tab-close", (event) => closed.push(event.detail));

    clickButton(element.render(), "Close plan.md");

    expect(templateToString(element.render())).not.toContain("Close Changes");
    expect(closed).toEqual([inspector.tabs[1]!.key]);
  });

  test("focuses a tab when it is chosen", () => {
    const inspector = testInspector();
    inspector.open(plan);
    const element = inspectorElement(inspector);
    const focused: string[] = [];
    element.addEventListener("inspector-tab-focus", (event) => focused.push(event.detail));

    clickButton(element.render(), "Changes");

    expect(focused).toEqual(["diff-file-tree"]);
  });

  test("renders view mounts for each tab's icon and content, with its view's pane, the view and the context", () => {
    const inspector = testInspector();
    const view = { ...plan, startLine: 3 };
    inspector.open(view);
    const element = inspectorElement(inspector);

    const presentations = collectTemplateProperties(element.render(), "presentation");
    expect(presentations).toHaveLength(4);
    expect(presentations[0]).toBe(treePane.icon);
    expect(presentations[1]).toBe(filePane.icon);
    expect(presentations.slice(2)).toEqual([treePane, filePane]);
    expect(collectTemplateProperties(element.render(), "view")).toEqual([{ view: "diff-file-tree" }, view, { view: "diff-file-tree" }, view]);
    expect(collectTemplateProperties(element.render(), "context")).toEqual(Array(4).fill(element.context));
  });

  test("shows a view whose renderer is gone as unavailable", () => {
    const inspector = testInspector();
    inspector.open(plan);
    const element = inspectorElement(inspector);
    element.views = new ViewRegistry();

    const output = templateToString(element.render());

    expect(output.match(/This view is not available\./g)).toHaveLength(2);
    expect(output).not.toContain("<reins-view-mount");
  });
});
