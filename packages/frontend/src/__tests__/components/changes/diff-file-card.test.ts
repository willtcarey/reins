import { describe, expect, test } from "bun:test";
import { DiffFileCard } from "../../../components/changes/diff-file-card.js";
import type { DiffFile } from "../../../models/changes/types.js";

function file(path: string): DiffFile {
  return {
    path,
    additions: 1,
    removals: 0,
    hunks: [
      {
        header: "@@ -1 +1 @@",
        lines: [{ type: "add", text: "hello", newLine: 1 }],
      },
    ],
  };
}

describe("DiffFileCard open in browser", () => {
  test("opens HTML files on the file browser Preview tab", () => {
    const card = new DiffFileCard();
    card.file = file("public/index.html");

    let detail: unknown;
    card.addEventListener("open-in-browser", (event) => {
      if (event instanceof CustomEvent) detail = event.detail;
    });

    card["_openInBrowser"](new Event("click"));

    expect(detail).toEqual({ path: "public/index.html", viewMode: "preview" });
  });

  test("opens non-HTML files without a requested view mode", () => {
    const card = new DiffFileCard();
    card.file = file("src/app.ts");

    let detail: unknown;
    card.addEventListener("open-in-browser", (event) => {
      if (event instanceof CustomEvent) detail = event.detail;
    });

    card["_openInBrowser"](new Event("click"));

    expect(detail).toEqual({ path: "src/app.ts" });
  });
});
