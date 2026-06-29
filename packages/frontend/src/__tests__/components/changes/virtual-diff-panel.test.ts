import { describe, expect, test } from "bun:test";
import { VirtualDiffPanel } from "../../../components/changes/virtual-diff-panel.js";
import { DiffStore } from "../../../models/stores/diff-store.js";
import { parseVirtualDiffPatch } from "../../../models/changes/virtual-diff.js";
import { templateToString } from "../../helpers/lit-template.js";

const PATCH = `diff --git a/demo.txt b/demo.txt
index 1111111..2222222 100644
--- a/demo.txt
+++ b/demo.txt
@@ -1 +1 @@
-old
+new
`;

const TWO_FILE_PATCH = `${PATCH}diff --git a/deep.txt b/deep.txt
index 1111111..2222222 100644
--- a/deep.txt
+++ b/deep.txt
@@ -1000 +1000 @@
-old
+new
`;

describe("VirtualDiffPanel", () => {
  test("renders parsed virtual diff state without reading DiffStore.fullData", () => {
    const store = new DiffStore();
    store.virtualData = {
      ...parseVirtualDiffPatch(PATCH, { cacheKeyPrefix: "project-1" }),
      branch: "feature/virtual",
      baseBranch: "main",
    };
    store.fullData = {
      files: [{ path: "classic-only.txt", additions: 0, removals: 0, hunks: [] }],
      branch: "classic",
      baseBranch: "main",
    };

    const el = new VirtualDiffPanel();
    el.store = store;

    const output = templateToString(el.render());

    expect(output).toContain("Virtual diff prototype");
    expect(output).toContain("demo.txt");
    expect(output).toContain("old");
    expect(output).toContain("new");
    expect(output).not.toContain("classic-only.txt");

    store.dispose();
  });

  test("keeps line-number gutters tight and consistent across files", () => {
    const store = new DiffStore();
    store.virtualData = {
      ...parseVirtualDiffPatch(TWO_FILE_PATCH, { cacheKeyPrefix: "project-1" }),
      branch: null,
      baseBranch: null,
    };

    const el = new VirtualDiffPanel();
    el.store = store;

    const output = templateToString(el.render());

    expect(output.match(/--virtual-diff-gutter: 5ch/g)).toHaveLength(1);
    expect(output).not.toContain("--virtual-diff-gutter: 2ch");
    expect(output).not.toContain("4rem");

    store.dispose();
  });
});
