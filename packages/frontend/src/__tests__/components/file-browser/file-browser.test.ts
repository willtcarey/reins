import { afterEach, describe, expect, test } from "bun:test";
import { FileBrowser } from "../../../components/file-browser/file-browser.js";
import { FileBrowserStore } from "../../../models/stores/file-browser-store.js";
import { clickButton, templateToString } from "../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { installTestHost } from "../../helpers/reins-sdk.js";

const source = { nodeId: "node", path: "/work" };

function browserAt(path: string, options: { startLine?: number; endLine?: number; mode?: "code" | "preview" } = {}) {
  mockFetch((url) => (url.includes("/files/tree")
    ? Response.json({ entries: [] })
    : new Response("text", { headers: { "content-type": "text/plain" } })));
  const { opened } = installTestHost({ source, projectId: 7 });
  const store = new FileBrowserStore();
  store.open(source, { path, ...options });
  const browser = new FileBrowser();
  browser.store = store;
  return { browser, store, opened };
}

afterEach(() => restoreFetch());

describe("FileBrowser header actions", () => {
  test("renders a download link for the shown file", () => {
    const { browser } = browserAt("docs/report.pdf");

    const output = templateToString(browser.render());

    expect(output).toContain("/api/projects/7/files/content?path=docs%2Freport.pdf&download=1");
    expect(output).toContain("Download docs/report.pdf");
  });

  test("closes when the HTML preview asks Escape to dismiss it", () => {
    const { browser, store } = browserAt("public/index.html");

    browser["_onHtmlPreviewEscape"]();

    expect(store.browserOpen).toBe(false);
  });

  test("opens the shown file with its lines and Code/Preview choice in the Inspector, and closes", () => {
    const { browser, store, opened } = browserAt("docs/plan.md", { startLine: 10, endLine: 12 });
    store.setMode("preview");

    clickButton(browser.render(), "Open in Inspector");

    expect(opened).toEqual([{
      view: { view: "file", path: "docs/plan.md", startLine: 10, endLine: 12, mode: "preview" },
      container: "inspector",
      projectId: 7,
    }]);
    expect(store.browserOpen).toBe(false);
  });
});
