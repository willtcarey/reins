import { describe, expect, test } from "bun:test";
import {
  createReviewVirtualLayout,
  estimateReviewItemHeight,
  measureReviewVirtualLayout,
  reviewVirtualWindow,
} from "../../../models/changes/review-virtual-layout.js";
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

  test("selects only viewport and overscan records while retaining total geometry", () => {
    const layout = createReviewVirtualLayout(
      Array.from({ length: 100 }, (_, index) => ({ id: `file-${index}`, height: 100 })),
    );

    const window = reviewVirtualWindow(layout, {
      scrollTop: 2_000,
      viewportHeight: 300,
      overscan: 100,
    });

    expect(window.items.map((item) => item.id)).toEqual([
      "file-19",
      "file-20",
      "file-21",
      "file-22",
      "file-23",
    ]);
    expect(window.paddingTop).toBe(1_900);
    expect(window.paddingBottom).toBe(7_600);
    expect(layout.totalHeight).toBe(10_000);
  });

  test("locates initially unmounted records and derives the active record from scroll geometry", () => {
    const layout = createReviewVirtualLayout([
      { id: "first", height: 80 },
      { id: "target", height: 240 },
      { id: "last", height: 120 },
    ]);

    expect(layout.byId.get("target")?.top).toBe(80);
    expect(reviewVirtualWindow(layout, {
      scrollTop: 300,
      viewportHeight: 100,
      overscan: 0,
    }).activeId).toBe("target");
  });

  test("compensates scroll only when measured height changes above the viewport anchor", () => {
    const layout = createReviewVirtualLayout([
      { id: "above", height: 100 },
      { id: "visible", height: 100 },
      { id: "below", height: 100 },
    ]);

    expect(measureReviewVirtualLayout(layout, "above", 160, 150)).toEqual({
      changed: true,
      scrollAdjustment: 60,
    });
    expect(measureReviewVirtualLayout(layout, "visible", 160, 150)).toEqual({
      changed: true,
      scrollAdjustment: 0,
    });
  });
});
