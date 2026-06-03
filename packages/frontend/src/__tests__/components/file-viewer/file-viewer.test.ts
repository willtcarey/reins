import { describe, expect, test } from "bun:test";
import { FileBrowser } from "../../../components/file-viewer/file-browser.js";
import { FileViewer } from "../../../components/file-viewer/file-viewer.js";
import {
  FileViewerHtml,
  buildSandboxedHtmlPreview,
} from "../../../components/file-viewer/file-viewer-html.js";
import { FileBrowserStore } from "../../../models/stores/file-browser-store.js";
import {
  collectTemplateValues,
  templateToString,
} from "../../helpers/lit-template.js";

function storeFor(path: string, content: string): FileBrowserStore {
  const store = new FileBrowserStore();
  store.projectId = 7;
  store.selectedFile = path;
  store.fileContent = content;
  store.isBinary = false;
  store.contentLoading = false;
  return store;
}

describe("FileViewer HTML preview", () => {
  test("keeps Code as the default tab for HTML files", () => {
    const viewer = new FileViewer();
    viewer.store = storeFor("public/index.html", "<h1>Hello</h1>");

    const output = templateToString(viewer.render());

    expect(output).toContain("view-mode-tabs");
    expect(output).toContain("file-viewer-code");
    expect(output).not.toContain("file-viewer-html");
  });

  test("renders the sandboxed HTML preview when the Preview tab is selected", () => {
    const viewer = new FileViewer();
    viewer.store = storeFor("public/index.html", "<h1>Hello</h1>");

    viewer["_onTabChange"](new CustomEvent("tab-change", { detail: 1 }));

    const output = templateToString(viewer.render());
    expect(output).toContain("file-viewer-html");
  });

  test("honors an initial Preview view for HTML files", () => {
    const viewer = new FileViewer();
    viewer.store = storeFor("public/index.html", "<h1>Hello</h1>");
    viewer.initialView = "preview";

    viewer.willUpdate(new Map([["store", undefined], ["initialView", undefined]]));

    const output = templateToString(viewer.render());
    expect(output).toContain("file-viewer-html");
    expect(output).not.toContain("file-viewer-code");
  });

  test("does not add an HTML preview tab for non-HTML text files", () => {
    const viewer = new FileViewer();
    viewer.store = storeFor("src/app.ts", "export const x = 1;\n");

    const output = templateToString(viewer.render());

    expect(output).toContain("file-viewer-code");
    expect(output).not.toContain("view-mode-tabs");
    expect(output).not.toContain("file-viewer-html");
  });
});

describe("FileViewerHtml", () => {
  test("renders a sandboxed iframe without an in-preview banner", () => {
    const viewer = new FileViewerHtml();
    viewer.content = "<h1>Hello</h1>";

    const rendered = viewer.render();
    const output = templateToString(rendered);

    expect(output).not.toContain("Relative assets are not resolved");
    expect(output).not.toContain("External navigation is blocked");
    expect(output).toContain("sandbox=\"allow-scripts\"");
    expect(output).toContain("referrerpolicy=\"no-referrer\"");
  });

  test("passes a sandbox document to the iframe srcdoc property", () => {
    const viewer = new FileViewerHtml();
    viewer.content = "<h1>Hello</h1>";

    const values = collectTemplateValues(viewer.render());

    expect(values).toContain(buildSandboxedHtmlPreview("<h1>Hello</h1>"));
  });

  test("dispatches an escape event for messages from its own iframe", () => {
    const viewer = new FileViewerHtml();
    const channel = new MessageChannel();
    const source = channel.port1;
    viewer["_iframeMessageSource"] = source;

    let requestedClose = false;
    viewer.addEventListener("html-preview-escape", () => {
      requestedClose = true;
    });

    const message = new MessageEvent("message", {
      data: { type: "reins:file-preview:escape" },
      source,
    });
    viewer["_onMessage"](message);

    expect(requestedClose).toBe(true);
  });

  test("ignores escape messages from other frames", () => {
    const viewer = new FileViewerHtml();
    const channel = new MessageChannel();
    const source = channel.port1;
    const otherSource = channel.port2;
    viewer["_iframeMessageSource"] = source;

    let requestedClose = false;
    viewer.addEventListener("html-preview-escape", () => {
      requestedClose = true;
    });

    const message = new MessageEvent("message", {
      data: { type: "reins:file-preview:escape" },
      source: otherSource,
    });
    viewer["_onMessage"](message);

    expect(requestedClose).toBe(false);
  });
});

describe("FileBrowser HTML preview escape", () => {
  test("closes the overlay when HTML preview requests Escape dismissal", () => {
    const browser = new FileBrowser();
    browser.store = storeFor("public/index.html", "<h1>Hello</h1>");
    browser["_open"] = true;
    browser["_mobileTreeOpen"] = true;

    browser["_onHtmlPreviewEscape"]();

    expect(browser["_open"]).toBe(false);
    expect(browser["_mobileTreeOpen"]).toBe(false);
  });
});

describe("buildSandboxedHtmlPreview", () => {
  test("injects a base target and Escape bridge before the user's head content", () => {
    const doc = buildSandboxedHtmlPreview(
      "<!doctype html><html><head><title>Hello</title></head><body><a href='https://example.com'>link</a></body></html>",
    );

    expect(doc).toContain('<base href="about:blank" target="_blank">');
    expect(doc.indexOf("<base")).toBeLessThan(doc.indexOf("<title>Hello</title>"));
    expect(doc).toContain("script-src 'unsafe-inline'");
    expect(doc).not.toContain("script-src 'none'");
    expect(doc).toContain("form-action 'none'");
    expect(doc).toContain("navigate-to 'none'");
    expect(doc).toContain('event.key === "Escape"');
    expect(doc).toContain('parent.postMessage({ type: "reins:file-preview:escape" }, "*")');
    expect(doc.indexOf("reins:file-preview:escape")).toBeLessThan(doc.indexOf("<title>Hello</title>"));
  });

  test("wraps HTML fragments in a complete sandbox document", () => {
    const doc = buildSandboxedHtmlPreview("<h1>Hello</h1>");

    expect(doc).toStartWith("<!doctype html>");
    expect(doc).toContain("<body><h1>Hello</h1></body>");
  });
});
