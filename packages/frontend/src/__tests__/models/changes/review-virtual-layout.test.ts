import { describe, expect, test } from "bun:test";
import { estimateFileChangeHeight, fileChangeGap } from "../../../models/changes/review-virtual-layout.js";
import { parseFileChanges } from "../../../models/changes/file-changes.js";

describe("review virtual layout", () => {
  test("estimates Pierre rows, separators, metadata, and stable file-change spacing", () => {
    const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,3 @@
 context
-old
+new
 context2
@@ -30 +30 @@
-before
+after
\\ No newline at end of file
`;
    const change = parseFileChanges(patch, "snapshot").changes[0]!;

    expect(estimateFileChangeHeight(change, false)).toBe(281);
    expect(estimateFileChangeHeight(change, true)).toBe(37);
    expect(fileChangeGap(0)).toBe(0);
    expect(fileChangeGap(1)).toBe(16);
  });

  test("estimates an oversized-file notice from its header and message", () => {
    const patch = `diff --git a/generated.json b/generated.json
--- a/generated.json
+++ b/generated.json
@@ -1 +1 @@
-old
+new
`;
    const parsed = parseFileChanges(patch, "snapshot").changes[0]!;
    const change = { ...parsed, additions: 10_000 };

    expect(estimateFileChangeHeight(change, false)).toBe(90);
    expect(estimateFileChangeHeight(change, true)).toBe(37);
  });
});
