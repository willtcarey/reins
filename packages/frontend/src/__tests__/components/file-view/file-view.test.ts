import { afterEach, describe, expect, test } from "bun:test";
import { InspectorFileView, registerFileView } from "../../../components/file-view/file-view.js";
import { collectTemplateProperties } from "../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { placedHost } from "../../helpers/reins-sdk.js";

afterEach(() => restoreFetch());

describe("the file view", () => {
  test("registers as the file view, titled by the file's name", () => {
    const { host, sdk } = placedHost();

    registerFileView(sdk);

    const renderer = host.renderer({ view: "file", path: "docs/plan.md" });
    expect(renderer?.title({ view: "file", path: "docs/plan.md" })).toBe("plan.md");
    expect(renderer?.element).toBe("inspector-file-view");
    expect(customElements.get("inspector-file-view")).toBeDefined();
  });

  test("reads its file, shows the lines and tab it was opened at, and reads it again when opened again", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return new Response("line\n".repeat(20), { headers: { "content-type": "text/plain" } });
    });
    const { files, source } = placedHost({ projectId: 3 });
    const element = new InspectorFileView(files);
    element.view = { view: "file", path: "docs/plan.md", startLine: 4, endLine: 6, mode: "preview" };
    element.context = { source };

    element.willUpdate(new Map<string, unknown>([["view", null], ["context", null]]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toEqual(["/api/projects/3/files/content?path=docs%2Fplan.md"]);
    expect(collectTemplateProperties(element.render(), "file")).toEqual([{ loading: false, text: "line\n".repeat(20), isBinary: false, error: null }]);
    expect(collectTemplateProperties(element.render(), "highlightRequest")).toEqual([{ startLine: 4, endLine: 6 }]);
    expect(collectTemplateProperties(element.render(), "initialView")).toEqual(["preview"]);

    const highlight = collectTemplateProperties(element.render(), "highlightRequest")[0];
    element.view = { view: "file", path: "docs/plan.md", startLine: 4, endLine: 6, mode: "preview" };
    element.willUpdate(new Map<string, unknown>([["view", null]]));

    expect(requests).toHaveLength(2);
    expect(collectTemplateProperties(element.render(), "highlightRequest")[0]).not.toBe(highlight);
  });
});
