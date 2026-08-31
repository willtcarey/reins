import { describe, expect, test } from "bun:test";
import { DiffFileTree } from "../../../components/changes/diff-file-tree.js";
import { Loadable } from "../../../helpers/loadable.js";
import { CodeReviewStore } from "../../../models/stores/code-review-store.js";
import { DiffStore, type DiffFileData } from "../../../models/stores/diff-store.js";
import {
  collectTemplateEventListeners,
  isTemplateResult,
  templateToString,
} from "../../helpers/lit-template.js";

function renderedNodeTrailer(template: unknown, path: string): string {
  if (!isTemplateResult(template)) throw new Error("Expected rendered file tree");
  const index = template.strings.findIndex((part) => part.trimEnd().endsWith(".renderNodeTrailer="));
  if (index >= 0) {
    const trailer = template.values[index];
    if (typeof trailer !== "function") throw new Error("Expected node trailer renderer");
    return templateToString(trailer({ name: path.split("/").at(-1)!, path, type: "file" }));
  }
  for (const value of template.values) {
    if (isTemplateResult(value)) {
      const output = renderedNodeTrailer(value, path);
      if (output) return output;
    }
  }
  return "";
}

describe("DiffFileTree", () => {
  test("shows the active review comment count beside each changed file", () => {
    const el = new DiffFileTree();
    const store = new DiffStore();
    store.fileData = Loadable.idle<DiffFileData>().asLoaded({
      branch: "feature/review",
      baseBranch: "master",
      files: [
        { path: "src/commented.ts", additions: 1, removals: 0 },
        { path: "src/plain.ts", additions: 1, removals: 0 },
      ],
    });
    const reviewStore = new CodeReviewStore();
    reviewStore.review = {
      id: "review-1",
      projectId: 7,
      taskId: 11,
      revision: 1,
      annotations: [{
        id: "annotation-1",
        anchor: {
          path: "src/commented.ts", oldPath: null, side: "new", startLine: 1, endLine: 1,
          excerpt: "new", contextBefore: null, contextAfter: null, fileFingerprint: null,
          baseRevision: null, headRevision: null,
        },
        entries: [
          { id: "entry-1", author: "You", body: "First", createdAt: "now" },
          { id: "entry-2", author: "Agent", body: "Second", createdAt: "later" },
        ],
      }],
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
    };
    el.store = store;
    el.reviewStore = reviewStore;

    const rendered = el.render();

    expect(renderedNodeTrailer(rendered, "src/commented.ts")).toContain("2 review comments");
    expect(renderedNodeTrailer(rendered, "src/plain.ts")).not.toContain("review comments");
    store.dispose();
  });

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
