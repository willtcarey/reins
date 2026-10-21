import { describe, expect, test } from "bun:test";
import { WorkspaceInspector } from "../../../components/inspector/workspace-inspector.js";
import { InspectorFileView } from "../../../components/inspector/inspector-file-view.js";
import { FileTreeState } from "../../../models/changes/file-tree-state.js";
import { Inspector } from "../../../models/inspector.js";
import { ProjectFiles } from "../../../models/stores/project-files.js";
import { SessionCache } from "../../../models/stores/session-cache.js";
import { clickButton, collectTemplateProperties, templateToString } from "../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { StubClient } from "../../helpers/stub-client.js";

function inspectorElement(inspector: Inspector): WorkspaceInspector {
  const element = new WorkspaceInspector();
  element.tabs = inspector.tabs;
  element.activeKey = inspector.activeTab.key;
  // The tab strip only hands the context on to the views it renders.
  element.context = { store: Object.create(null), files: Object.create(null), source: null, changesTreeState: new FileTreeState(), activeDiffFile: null };
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
  test("reads its file, shows the lines and tab it was opened at, and reads it again when opened again", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return new Response("line\n".repeat(20), { headers: { "content-type": "text/plain" } });
    });
    try {
      const view = new InspectorFileView();
      view.files = new ProjectFiles(new StubClient(), new SessionCache());
      view.source = { projectId: 3, nodeId: "node", path: "/work", available: true };
      view.path = "docs/plan.md";
      view.startLine = 4;
      view.endLine = 6;
      view.mode = "preview";
      view.revision = 1;

      view.willUpdate(new Map<string, unknown>([["files", null], ["path", ""], ["revision", 0]]));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(requests).toEqual(["/api/projects/3/files/content?path=docs%2Fplan.md"]);
      expect(collectTemplateProperties(view.render(), "file")).toEqual([{ loading: false, text: "line\n".repeat(20), isBinary: false, error: null }]);
      expect(collectTemplateProperties(view.render(), "highlightRequest")).toEqual([{ id: 1, startLine: 4, endLine: 6 }]);
      expect(collectTemplateProperties(view.render(), "initialView")).toEqual(["preview"]);

      view.revision = 2;
      view.willUpdate(new Map<string, unknown>([["revision", 1]]));
      expect(requests).toHaveLength(2);
    } finally {
      restoreFetch();
    }
  });
});
