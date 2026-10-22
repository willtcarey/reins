import { describe, expect, test } from "bun:test";
import { reins } from "reins-sdk";
import { WorkspaceInspector } from "../../../components/inspector/workspace-inspector.js";
import { Inspector } from "../../../models/inspector.js";
import type { ViewOf } from "../../../reins-sdk/contract.js";
import { clickButton, collectTemplateProperties, templateToString } from "../../helpers/lit-template.js";
import { installTestHost } from "../../helpers/reins-sdk.js";

const filePane = {
  title: (view: ViewOf<"file">) => view.path.slice(view.path.lastIndexOf("/") + 1),
  description: (view: ViewOf<"file">) => view.path,
  icon: "file" as const,
  mount: () => {},
};

const treePane = { title: () => "Changes", description: () => "Changed files", icon: "diff" as const, mount: () => {} };

function inspectorElement(inspector: Inspector): WorkspaceInspector {
  const { host, source } = installTestHost();
  reins.views.register("diff-file-tree", { pane: treePane });
  reins.views.register("file", { pane: filePane });
  const element = new WorkspaceInspector();
  element.tabs = inspector.tabs;
  element.activeKey = inspector.activeTab.key;
  element.renderers = host;
  element.context = { source };
  return element;
}

describe("WorkspaceInspector", () => {
  test("offers closing every tab but the diff file tree's", () => {
    const inspector = new Inspector();
    inspector.open({ view: "file", path: "docs/plan.md" });
    const element = inspectorElement(inspector);
    const closed: string[] = [];
    element.addEventListener("inspector-tab-close", (event) => closed.push(event.detail));

    clickButton(element.render(), "Close plan.md");

    expect(templateToString(element.render())).not.toContain("Close Changes");
    expect(closed).toEqual(["file:docs/plan.md"]);
  });

  test("focuses a tab when it is chosen", () => {
    const inspector = new Inspector();
    inspector.open({ view: "file", path: "docs/plan.md" });
    const element = inspectorElement(inspector);
    const focused: string[] = [];
    element.addEventListener("inspector-tab-focus", (event) => focused.push(event.detail));

    clickButton(element.render(), "Changes");

    expect(focused).toEqual(["diff-file-tree"]);
  });

  test("renders a view host for each tab with its view's pane, the view and the context", () => {
    const inspector = new Inspector();
    const view = { view: "file" as const, path: "docs/plan.md", startLine: 3 };
    inspector.open(view);
    const element = inspectorElement(inspector);

    expect(collectTemplateProperties(element.render(), "presentation")).toEqual([treePane, filePane]);
    expect(collectTemplateProperties(element.render(), "view")).toEqual([{ view: "diff-file-tree" }, view]);
    expect(collectTemplateProperties(element.render(), "context")).toEqual([element.context, element.context]);
  });

  test("shows a view whose renderer is gone as unavailable", () => {
    const inspector = new Inspector();
    inspector.open({ view: "file", path: "docs/plan.md" });
    const element = inspectorElement(inspector);
    element.renderers = installTestHost().host;

    const output = templateToString(element.render());

    expect(output.match(/This view is not available\./g)).toHaveLength(2);
    expect(output).not.toContain("<reins-view-host");
  });
});
