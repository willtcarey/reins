import { describe, expect, test } from "bun:test";
import { WorkspaceInspector } from "../../../components/inspector/workspace-inspector.js";
import { Inspector } from "../../../models/inspector.js";
import { viewKey, type ViewOf } from "../../../reins-sdk/contract.js";
import { ViewRegistry } from "../../../reins-sdk/view-registry.js";
import { clickButton, collectTemplateProperties, templateToString } from "../../helpers/lit-template.js";

const source = { nodeId: "node", path: "/work" };
const plan: ViewOf<"file"> = { view: "file", source, path: "docs/plan.md" };

const filePane = {
  title: (view: ViewOf<"file">) => view.path.slice(view.path.lastIndexOf("/") + 1),
  description: (view: ViewOf<"file">) => view.path,
  icon: "file" as const,
  mount: () => {},
};

const treePane = { title: () => "Changes", description: () => "Changed files", icon: "diff" as const, mount: () => {} };

function inspectorElement(inspector: Inspector): WorkspaceInspector {
  const views = new ViewRegistry();
  views.register("diff-file-tree", { pane: treePane });
  views.register("file", { pane: filePane });
  const element = new WorkspaceInspector();
  element.tabs = inspector.tabs;
  element.activeKey = inspector.activeTab.key;
  element.views = views;
  element.context = { source };
  return element;
}

describe("WorkspaceInspector", () => {
  test("offers closing every tab but the diff file tree's", () => {
    const inspector = new Inspector();
    inspector.open(plan);
    const element = inspectorElement(inspector);
    const closed: string[] = [];
    element.addEventListener("inspector-tab-close", (event) => closed.push(event.detail));

    clickButton(element.render(), "Close plan.md");

    expect(templateToString(element.render())).not.toContain("Close Changes");
    expect(closed).toEqual([viewKey(plan)]);
  });

  test("focuses a tab when it is chosen", () => {
    const inspector = new Inspector();
    inspector.open(plan);
    const element = inspectorElement(inspector);
    const focused: string[] = [];
    element.addEventListener("inspector-tab-focus", (event) => focused.push(event.detail));

    clickButton(element.render(), "Changes");

    expect(focused).toEqual(["diff-file-tree"]);
  });

  test("renders a view mount for each tab with its view's pane, the view and the context", () => {
    const inspector = new Inspector();
    const view = { ...plan, startLine: 3 };
    inspector.open(view);
    const element = inspectorElement(inspector);

    expect(collectTemplateProperties(element.render(), "presentation")).toEqual([treePane, filePane]);
    expect(collectTemplateProperties(element.render(), "view")).toEqual([{ view: "diff-file-tree" }, view]);
    expect(collectTemplateProperties(element.render(), "context")).toEqual([element.context, element.context]);
  });

  test("shows a view whose renderer is gone as unavailable", () => {
    const inspector = new Inspector();
    inspector.open(plan);
    const element = inspectorElement(inspector);
    element.views = new ViewRegistry();

    const output = templateToString(element.render());

    expect(output.match(/This view is not available\./g)).toHaveLength(2);
    expect(output).not.toContain("<reins-view-mount");
  });
});
