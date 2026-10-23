import { afterEach, describe, expect, test } from "bun:test";
import type { ViewOf } from "reins-sdk/contract";
import { InspectorFileView, registerFileView } from "../../../components/file-view/file-view.js";
import { collectTemplateProperties } from "../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testSdk } from "../../helpers/reins-sdk.js";
import { testElement } from "../../helpers/test-dom.js";

afterEach(() => restoreFetch());

describe("the file view", () => {
  test("registers as the file view's pane, titled by the file's name", () => {
    const { reins, views, source } = testSdk();

    registerFileView(reins);

    const view: ViewOf<"file"> = { view: "file", source, path: "docs/plan.md" };
    const pane = views.rendererFor(view)?.pane;
    expect(pane?.title(view)).toBe("plan.md");
    expect(pane?.description(view)).toBe("docs/plan.md");
  });

  test("mounts as a file view element given its view and the SDK's files, updated in place, and removed on dispose", () => {
    const { reins, views, files, source } = testSdk();
    registerFileView(reins);
    const view: ViewOf<"file"> = { view: "file", source, path: "docs/plan.md" };
    const pane = views.rendererFor(view)?.pane;
    const target = testElement();

    const mounted = pane?.mount(target, view, { source });
    const element = target.childNodes[0];
    if (!(element instanceof InspectorFileView)) throw new Error("Expected the file view");
    expect(element.view).toBe(view);
    expect(element.files).toBe(files);

    const opened: ViewOf<"file"> = { view: "file", source, path: "docs/plan.md", startLine: 3 };
    mounted?.update?.(opened, { source });
    expect(element.view).toBe(opened);
    expect(target.childNodes[0]).toBe(element);

    mounted?.dispose?.();
    expect([...target.childNodes]).toEqual([]);
  });

  test("reads its file, shows the lines and tab it was opened at, and reads it again when opened again", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return new Response("line\n".repeat(20), { headers: { "content-type": "text/plain" } });
    });
    const { files, source } = testSdk({ projectId: 3 });
    const element = new InspectorFileView();
    element.view = { view: "file", source, path: "docs/plan.md", startLine: 4, endLine: 6, mode: "preview" };
    element.files = files;

    element.willUpdate(new Map<string, unknown>([["view", null], ["files", null]]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toEqual(["/api/projects/3/files/content?path=docs%2Fplan.md"]);
    expect(collectTemplateProperties(element.render(), "file")).toEqual([{ loading: false, text: "line\n".repeat(20), isBinary: false, error: null }]);
    expect(collectTemplateProperties(element.render(), "highlightRequest")).toEqual([{ startLine: 4, endLine: 6 }]);
    expect(collectTemplateProperties(element.render(), "initialView")).toEqual(["preview"]);

    const highlight = collectTemplateProperties(element.render(), "highlightRequest")[0];
    element.view = { view: "file", source, path: "docs/plan.md", startLine: 4, endLine: 6, mode: "preview" };
    element.willUpdate(new Map<string, unknown>([["view", null]]));

    expect(requests).toHaveLength(2);
    expect(collectTemplateProperties(element.render(), "highlightRequest")[0]).not.toBe(highlight);
  });
});
