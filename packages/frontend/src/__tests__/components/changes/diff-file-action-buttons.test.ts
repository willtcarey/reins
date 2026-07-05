import { afterEach, describe, expect, test } from "bun:test";
import {
  DiffCopyPathButton,
  DiffDownloadFileButton,
  DiffViewFileButton,
} from "../../../components/changes/diff-file-action-buttons.js";
import { installTestClipboard, restoreTestClipboard } from "../../helpers/clipboard.js";
import { templateToString } from "../../helpers/lit-template.js";

afterEach(() => {
  restoreTestClipboard();
});

describe("shared diff file action buttons", () => {
  test("view file button opens HTML files on the Preview tab", () => {
    const el = new DiffViewFileButton();
    el.path = "public/index.html";
    const event = new Event("click", { bubbles: true });
    let detail: unknown;
    el.addEventListener("open-in-browser", (customEvent) => {
      detail = customEvent.detail;
    });

    const output = templateToString(el.render());
    el.handleClick(event);

    expect(output).toContain("View file");
    expect(detail).toEqual({ path: "public/index.html", viewMode: "preview" });
    expect(event.cancelBubble).toBe(true);
  });

  test("view file button opens non-HTML files without a requested view mode", () => {
    const el = new DiffViewFileButton();
    el.path = "src/app.ts";
    const event = new Event("click", { bubbles: true });
    let detail: unknown;
    el.addEventListener("open-in-browser", (customEvent) => {
      detail = customEvent.detail;
    });

    el.handleClick(event);

    expect(detail).toEqual({ path: "src/app.ts" });
    expect(event.cancelBubble).toBe(true);
  });

  test("copy path button copies the current path", async () => {
    installTestClipboard("previous clipboard text");
    const el = new DiffCopyPathButton();
    el.path = "demo.txt";
    const event = new Event("click", { bubbles: true });

    const output = templateToString(el.render());
    await el.handleClick(event);

    expect(output).toContain("Copy path");
    expect(await navigator.clipboard.readText()).toBe("demo.txt");
    expect(templateToString(el.render())).toContain("text-green-400");
    expect(event.cancelBubble).toBe(true);
    el.disconnectedCallback();
  });

  test("download file button ignores clicks without a href", () => {
    const el = new DiffDownloadFileButton();
    el.path = "demo.txt";
    const event = new Event("click", { bubbles: true });

    const output = templateToString(el.render());
    el.handleClick(event);

    expect(output).toContain("Download file");
    expect(event.cancelBubble).toBe(true);
  });
});
