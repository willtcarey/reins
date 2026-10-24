import { afterEach, describe, expect, test } from "bun:test";
import type { OpenInBrowserDetail } from "../../../components/events.js";
import { FileViewer, registerFileViewer, type FileView } from "../../../components/file-viewer/file-viewer.js";
import { clickButton, collectTemplateEventListeners, collectTemplateProperties, templateToString } from "../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testSdk } from "../../helpers/reins-sdk.js";
import { testElement } from "../../helpers/test-dom.js";

afterEach(() => restoreFetch());

describe("the file viewer", () => {
  test("registers as the `file` view's pane, titled by the file's name", () => {
    const { reins, views, source } = testSdk();

    registerFileViewer(reins);

    const view: FileView = { view: "file", source, path: "docs/plan.md" };
    const pane = views.rendererFor(view)?.pane;
    expect(pane?.title(view)).toBe("plan.md");
    expect(pane?.description(view)).toBe("docs/plan.md");
  });

  test("mounts as a file viewer given its view and the SDK's files, updated in place, and removed on dispose", () => {
    const { reins, views, files, source } = testSdk();
    registerFileViewer(reins);
    const view: FileView = { view: "file", source, path: "docs/plan.md" };
    const pane = views.rendererFor(view)?.pane;
    const target = testElement();

    const mounted = pane?.mount(target, view, { source });
    const element = target.childNodes[0];
    if (!(element instanceof FileViewer)) throw new Error("Expected a file viewer");
    expect(element.view).toBe(view);
    expect(element.files).toBe(files);

    const opened: FileView = { view: "file", source, path: "docs/plan.md", startLine: 3 };
    mounted?.update?.(opened, { source });
    expect(element.view).toBe(opened);
    expect(target.childNodes[0]).toBe(element);

    mounted?.dispose?.();
    expect([...target.childNodes]).toEqual([]);
  });

  test("reads its file, shows the lines it was opened at in the Code tab, and reads it again when opened again", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return new Response("line\n".repeat(20), { headers: { "content-type": "text/plain" } });
    });
    const { files, source } = testSdk({ projectId: 3 });
    const element = new FileViewer();
    element.view = { view: "file", source, path: "docs/plan.md", startLine: 4, endLine: 6, mode: "preview" };
    element.files = files;

    element.willUpdate(new Map<string, unknown>([["view", null], ["files", null]]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toEqual(["/api/projects/3/files/content?path=docs%2Fplan.md"]);
    expect(collectTemplateProperties(element.render(), "file")).toEqual([{ loading: false, text: "line\n".repeat(20), isBinary: false, error: null }]);
    expect(collectTemplateProperties(element.render(), "highlightRequest")).toEqual([{ startLine: 4, endLine: 6 }]);
    expect(collectTemplateProperties(element.render(), "initialMode")).toEqual(["code"]);

    const highlight = collectTemplateProperties(element.render(), "highlightRequest")[0];
    element.view = { view: "file", source, path: "docs/plan.md", startLine: 4, endLine: 6, mode: "preview" };
    element.willUpdate(new Map<string, unknown>([["view", null]]));

    expect(requests).toHaveLength(2);
    expect(collectTemplateProperties(element.render(), "highlightRequest")[0]).not.toBe(highlight);
  });

  test("shows the tab it was opened at", () => {
    const { files, source } = testSdk();

    const element = viewerOf({ view: "file", source, path: "docs/plan.md", mode: "preview" }, files);

    expect(collectTemplateProperties(element.render(), "initialMode")).toEqual(["preview"]);
  });

  test("in the Inspector, opens its file in the file browser with its lines and the tab the user is on", () => {
    const { files, source } = testSdk();
    const element = viewerOf({ view: "file", source, path: "docs/plan.md", startLine: 4, endLine: 6 }, files);
    const opened: OpenInBrowserDetail[] = [];
    element.addEventListener("open-in-browser", (event) => opened.push(event.detail));

    chooseTab(element, "preview");
    element.render();
    element["openElsewhere"]();

    expect(templateToString(element.render())).toContain("Open in file browser");
    expect(opened).toEqual([{ source, path: "docs/plan.md", startLine: 4, endLine: 6, mode: "preview" }]);
  });

  test("in the file browser, opens its file in the Inspector with its lines and the tab the user is on", () => {
    const { files, source } = testSdk();
    const element = viewerOf({ view: "file", source, path: "docs/plan.md", startLine: 4, endLine: 6 }, files);
    element.container = "file-browser";
    const opened: FileView[] = [];
    element.addEventListener("open-in-inspector", (event) => opened.push(event.detail));

    chooseTab(element, "preview");
    clickButton(element.render(), "Open in Inspector");

    expect(opened).toEqual([{ view: "file", source, path: "docs/plan.md", startLine: 4, endLine: 6, mode: "preview" }]);
  });

  test("links its file for download", () => {
    const { files, source } = testSdk({ projectId: 7 });

    const element = viewerOf({ view: "file", source, path: "docs/report.pdf" }, files);

    const output = templateToString(element.render());
    expect(output).toContain("/api/projects/7/files/content?path=docs%2Freport.pdf&download=1");
    expect(output).toContain("Download docs/report.pdf");
  });
});

function viewerOf(view: FileView, files: FileViewer["files"]): FileViewer {
  const element = new FileViewer();
  element.view = view;
  element.files = files;
  element.willUpdate(new Map<string, unknown>([["view", null], ["files", null]]));
  return element;
}

/** The user choosing a Code/Preview tab in the viewer's content. */
function chooseTab(element: FileViewer, mode: "code" | "preview") {
  for (const listener of collectTemplateEventListeners(element.render(), "file-viewer-mode-change")) {
    listener(new CustomEvent("file-viewer-mode-change", { detail: mode }));
  }
}
