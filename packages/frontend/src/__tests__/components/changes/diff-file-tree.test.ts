import { describe, expect, test } from "bun:test";
import { DiffFileTree } from "../../../components/changes/diff-file-tree.js";
import { Loadable } from "../../../helpers/loadable.js";
import { DiffStore, type DiffFileData } from "../../../models/stores/diff-store.js";
import { collectTemplateEventListeners } from "../../helpers/lit-template.js";

describe("DiffFileTree", () => {
  test("emits file-select when the rendered tree-view reports a file click", () => {
    const el = new DiffFileTree();
    const store = new DiffStore();
    store.fileData = Loadable.idle<DiffFileData>().asLoaded({
      branch: "feature/mobile-nav",
      baseBranch: "master",
      files: [{ path: "src/file.ts", additions: 1, removals: 0 }],
    });
    el.store = store;
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

    const [fileClick] = collectTemplateEventListeners(el.render(), "tree-file-click");
    expect(fileClick).toBeDefined();
    fileClick.call(el, new CustomEvent("tree-file-click", { detail: "src/file.ts" }));

    expect(selected).toEqual([{ path: "src/file.ts", bubbles: true, composed: true }]);
  });
});
