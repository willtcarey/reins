import { afterEach, describe, expect, test } from "bun:test";
import type { ViewOf } from "reins-sdk/contract";
import { FileBrowser } from "../../../components/file-browser/file-browser.js";
import { openInInspectorEvent } from "../../../components/events.js";
import { FileBrowserStore } from "../../../models/stores/file-browser-store.js";
import { collectTemplateEventListeners, collectTemplateProperties, templateToString } from "../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testSdk } from "../../helpers/reins-sdk.js";

const source = { nodeId: "node", path: "/work" };

function browserAt(path: string, options: { startLine?: number; endLine?: number; mode?: "code" | "preview" } = {}) {
  mockFetch((url) => (url.includes("/files/tree")
    ? Response.json({ entries: [] })
    : new Response("text", { headers: { "content-type": "text/plain" } })));
  const { reins, opened } = testSdk({ source, projectId: 7 });
  const store = new FileBrowserStore(reins);
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
    const shown: ViewOf<"file"> = { view: "file", source, path: "docs/plan.md", startLine: 10, endLine: 12, mode: "preview" };

    for (const listener of collectTemplateEventListeners(browser.render(), "open-in-inspector")) listener(openInInspectorEvent(shown));

    expect(opened).toEqual([{ view: shown, container: "inspector" }]);
    expect(store.browserOpen).toBe(false);
  });
});
