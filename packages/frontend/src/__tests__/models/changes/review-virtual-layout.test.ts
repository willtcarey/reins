import { describe, expect, test } from "bun:test";
import { estimateReviewItemHeight } from "../../../models/changes/review-virtual-layout.js";
import { parseReviewItems } from "../../../models/changes/review-items.js";

describe("review virtual layout", () => {
  test("estimates Pierre rows, separators, metadata, and stable item spacing", () => {
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
    const item = parseReviewItems(patch, "snapshot").items[0]!;

    expect(estimateReviewItemHeight(item, false, 0)).toBe(281);
    expect(estimateReviewItemHeight(item, false, 1)).toBe(297);
    expect(estimateReviewItemHeight(item, true, 0)).toBe(37);
    expect(estimateReviewItemHeight(item, true, 1)).toBe(53);
  });
});
