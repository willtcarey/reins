import { describe, expect, test } from "bun:test";
import { estimateFileChangeHeight } from "../../../models/changes/review-virtual-layout.js";
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

    expect(estimateFileChangeHeight(change, false, 0)).toBe(281);
    expect(estimateFileChangeHeight(change, false, 1)).toBe(297);
    expect(estimateFileChangeHeight(change, true, 0)).toBe(37);
    expect(estimateFileChangeHeight(change, true, 1)).toBe(53);
  });
});
