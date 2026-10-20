import { describe, expect, test } from "bun:test";
import { WorkspaceInspector } from "../../../components/inspector/workspace-inspector.js";
import { InspectorFileView } from "../../../components/inspector/inspector-file-view.js";
import { FileTreeState } from "../../../models/changes/file-tree-state.js";
import { Inspector } from "../../../models/inspector.js";
import { FileModel } from "../../../models/stores/file-model.js";
import { clickButton, collectTemplateProperties, templateToString } from "../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

function inspectorElement(inspector: Inspector): WorkspaceInspector {
  const element = new WorkspaceInspector();
  element.tabs = inspector.tabs;
  element.activeKey = inspector.activeTab.key;
  // The tab strip only hands the context on to the views it renders.
  element.context = { store: Object.create(null), changesTreeState: new FileTreeState(), activeDiffFile: null };
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
});

describe("InspectorFileView", () => {
  test("reads its file and shows the lines it was opened at", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return new Response("line\n".repeat(20), { headers: { "content-type": "text/plain" } });
    });
    try {
      const model = new FileModel();
      model.setSource({ projectId: 3, nodeId: "node", checkoutPath: "/work", available: false });
      const view = new InspectorFileView();
      view.store = model;
      view.path = "src/app.ts";
      view.startLine = 4;
      view.endLine = 6;
      view.revision = 1;

      view.willUpdate(new Map<string, unknown>([["store", null], ["path", ""], ["revision", 0]]));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(requests).toEqual(["/api/projects/3/files/content?path=src%2Fapp.ts"]);
      expect(collectTemplateProperties(view.render(), "highlightRequest")).toEqual([{ id: 1, startLine: 4, endLine: 6 }]);

      view.revision = 2;
      view.willUpdate(new Map<string, unknown>([["revision", 1]]));
      expect(requests).toHaveLength(2);
    } finally {
      restoreFetch();
    }
  });
});
