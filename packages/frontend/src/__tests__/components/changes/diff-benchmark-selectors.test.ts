import { describe, expect, test } from "bun:test";
import { CodeViewDiffPanel } from "../../../components/changes/codeview-diff-panel.js";
import { DiffPanel } from "../../../components/changes/diff-panel.js";
import { ReviewDiffPanel } from "../../../components/changes/review-diff-panel.js";
import { DiffStore } from "../../../models/stores/diff-store.js";
import { templateToString } from "../../helpers/lit-template.js";

const PATCH = `diff --git a/example.ts b/example.ts
index 1111111..2222222 100644
--- a/example.ts
+++ b/example.ts
@@ -4,3 +4,3 @@
 context
-old
+new
 context
`;

describe("diff benchmark selectors", () => {
  test("exposes one stable scroll surface across all renderers", () => {
    const classicStore = new DiffStore();
    classicStore.fullData = classicStore.fullData.asLoaded({
      files: [{
        path: "example.ts",
        additions: 1,
        removals: 1,
        hunks: [],
      }],
      branch: "benchmark",
      baseBranch: "main",
    });
    const classic = new DiffPanel();
    classic.store = classicStore;

    const codeViewStore = patchStore();
    const codeView = new CodeViewDiffPanel();
    codeView.store = codeViewStore;

    const reviewStore = patchStore();
    const review = new ReviewDiffPanel();
    review.store = reviewStore;

    expect(templateToString(classic.render())).toContain("data-diff-scroll-surface");
    expect(templateToString(codeView.render())).toContain("data-diff-scroll-surface");
    expect(templateToString(review.render())).toContain("data-diff-scroll-surface");
    expect(templateToString(classic.render())).toContain("data-diff-file-wrapper");

    classicStore.dispose();
    codeViewStore.dispose();
    reviewStore.dispose();
  });
});

function patchStore(): DiffStore {
  const store = new DiffStore();
  store.patchData = store.patchData.asLoaded({
    patch: PATCH,
    cacheKeyPrefix: "benchmark-v1",
    version: 1,
    branch: "benchmark",
    baseBranch: "main",
  });
  return store;
}
