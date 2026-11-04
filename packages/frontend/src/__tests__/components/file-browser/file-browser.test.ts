import { afterEach, describe, expect, test } from "bun:test";
import { FileBrowser } from "../../../components/file-browser/file-browser.js";
import { openInInspectorEvent } from "../../../components/events.js";
import type { FileView } from "../../../components/file-viewer/file-viewer.js";
import { FileBrowserStore } from "../../../models/stores/file-browser-store.js";
import { collectTemplateEventListeners, collectTemplateProperties, templateToString } from "../../helpers/lit-template.js";
import { fileResponse, mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testSdk } from "../../helpers/reins-sdk.js";

const source = { nodeId: "node", path: "/work" };

function browserAt(path: string, options: { startLine?: number; endLine?: number; mode?: "code" | "preview" } = {}) {
  mockFetch((url) => (url.includes("/files/tree")
    ? Response.json({ entries: [] })
    : fileResponse("text")));
  const { reins, opened } = testSdk({ source, projectId: 7 });
  const store = new FileBrowserStore(reins, { viewedSource: () => null });
  store.open(source, { path, ...options });
  const browser = new FileBrowser();
  browser.store = store;
  return { browser, store, opened };
}

afterEach(() => restoreFetch());

describe("FileBrowser", () => {
  test("shows its file in a file viewer that offers to open it in the Inspector", () => {
    const { browser, store } = browserAt("docs/plan.md", { startLine: 10, endLine: 12 });

    const rendered = browser.render();

    expect(collectTemplateProperties(rendered, "view")).toEqual([store.view]);
    expect(templateToString(rendered)).toContain(`container="file-browser"`);
  });

  test("stays rendered, hidden, while closed after showing a file", () => {
    const { browser, store } = browserAt("docs/plan.md");

    store.close();

    expect(collectTemplateProperties(browser.render(), "view")).toEqual([store.view]);
    expect(templateToString(browser.render())).toContain(" hidden ");
  });

  test("closes when the HTML preview asks Escape to dismiss it", () => {
    const { browser, store } = browserAt("public/index.html");

    browser["_onHtmlPreviewEscape"]();

    expect(store.browserOpen).toBe(false);
  });

  test("opens the file in the Inspector as its viewer shows it, and closes", () => {
    const { browser, store, opened } = browserAt("docs/plan.md", { startLine: 10, endLine: 12 });
    const shown: FileView = { view: "file", source, path: "docs/plan.md", startLine: 10, endLine: 12, mode: "preview" };

    for (const listener of collectTemplateEventListeners(browser.render(), "open-in-inspector")) listener(openInInspectorEvent(shown));

    expect(opened).toEqual([{ view: shown, container: "inspector" }]);
    expect(store.browserOpen).toBe(false);
  });

  test("offers to upload into the open file's folder, uploads chosen or dropped files there, and shows its progress", () => {
    const { browser, store } = browserAt("docs/plan.md");
    const uploads: string[][] = [];
    store.upload = (files) => {
      uploads.push(Array.from(files, file => file.name));
      return new Promise(() => {});
    };
    const chosen = [new File(["a"], "a.txt")];
    const dropped = [new File(["b"], "b.txt")];

    const rendered = browser.render();
    expect(templateToString(rendered)).toContain("title=Upload files into docs/");
    const input = { files: chosen, value: "a.txt" };
    for (const listener of collectTemplateEventListeners(rendered, "change")) listener(Object.defineProperty(new Event("change"), "target", { value: input }));
    for (const listener of collectTemplateEventListeners(rendered, "drop")) listener(Object.defineProperty(new Event("drop"), "dataTransfer", { value: { files: dropped } }));

    expect(uploads).toEqual([["a.txt"], ["b.txt"]]);
    expect(input.value).toBe("");
    store.uploadProgress = 40;
    expect(templateToString(browser.render())).toContain("Uploading 40%");
  });
});
