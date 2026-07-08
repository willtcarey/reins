import { describe, expect, test } from "bun:test";
import { DiffFileTree } from "../../../components/changes/diff-file-tree.js";

describe("DiffFileTree", () => {
  test("emits file-select with the selected file path", () => {
    const el = new DiffFileTree();
    const selected: Array<{ path: string; bubbles: boolean; composed: boolean }> = [];

    el.addEventListener("file-select", (event) => {
      if (event instanceof CustomEvent) {
        selected.push({
          path: event.detail,
          bubbles: event.bubbles,
          composed: event.composed,
        });
      }
    });

    Reflect.get(el, "_handleFileClick").call(
      el,
      new CustomEvent("tree-file-click", { detail: "src/file.ts" }),
    );

    expect(selected).toEqual([{ path: "src/file.ts", bubbles: true, composed: true }]);
  });
});
