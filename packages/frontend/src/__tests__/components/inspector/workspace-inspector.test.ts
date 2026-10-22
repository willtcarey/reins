import { describe, expect, test } from "bun:test";
import { html } from "lit";
import { reins } from "reins-sdk";
import { WorkspaceInspector } from "../../../components/inspector/workspace-inspector.js";
import { Inspector } from "../../../models/inspector.js";
import { clickButton, collectTemplateProperties, templateToString } from "../../helpers/lit-template.js";
import { installTestHost } from "../../helpers/reins-sdk.js";

function inspectorElement(inspector: Inspector): WorkspaceInspector {
  const { host, source } = installTestHost();
  reins.views.register("file", {
    title: (view) => view.path.slice(view.path.lastIndexOf("/") + 1),
    description: (view) => view.path,
    icon: "file",
    element: "test-file-view",
  });
  const element = new WorkspaceInspector();
  element.tabs = inspector.tabs;
  element.activeKey = inspector.activeTab.key;
  element.renderers = host;
  element.context = { source };
  element.changes = html`<p>changed files</p>`;
  return element;
}

describe("WorkspaceInspector", () => {
  test("offers closing every tab but the changes tab", () => {
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

    expect(focused).toEqual(["changes"]);
  });

  test("renders the pinned Changes tab's content, and each registered view's element with its view and context", () => {
    const inspector = new Inspector();
    const view = { view: "file" as const, path: "docs/plan.md", startLine: 3 };
    inspector.open(view);
    const element = inspectorElement(inspector);

    const output = templateToString(element.render());

    expect(output).toContain("changed files");
    expect(output).toContain("<test-file-view");
    expect(collectTemplateProperties(element.render(), "view")).toEqual([view]);
    expect(collectTemplateProperties(element.render(), "context")).toEqual([element.context]);
  });

  test("shows a view whose renderer is gone as unavailable", () => {
    const inspector = new Inspector();
    inspector.open({ view: "file", path: "docs/plan.md" });
    const element = inspectorElement(inspector);
    element.renderers = installTestHost().host;

    const output = templateToString(element.render());

    expect(output).toContain("This view is not available.");
    expect(output).not.toContain("<test-file-view");
  });
});
