import { describe, expect, test } from "bun:test";
import {
  estimateReviewItemHeight,
  ReviewVirtualCoordinator,
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

  test("uses balanced bounded overscan while scrolling in either direction", () => {
    const coordinator = new ReviewVirtualCoordinator(100);
    coordinator.setItems(Array.from({ length: 100 }, (_, index) => ({
      id: `file-${index}`,
      measurementKey: `file-${index}:expanded`,
      estimatedHeight: 100,
    })));

    coordinator.setViewport(2_000, 300);
    expect(coordinator.window().items.map((item) => item.id)).toEqual([
      "file-19",
      "file-20",
      "file-21",
      "file-22",
      "file-23",
    ]);

    coordinator.setViewport(1_800, 300);
    expect(coordinator.window().items.map((item) => item.id)).toEqual([
      "file-17",
      "file-18",
      "file-19",
      "file-20",
      "file-21",
    ]);
    expect(coordinator.window().items.length).toBeLessThanOrEqual(5);
  });

  test("preserves an item and viewport-offset anchor when geometry above changes", () => {
    const coordinator = new ReviewVirtualCoordinator(0);
    coordinator.setItems([
      { id: "above", measurementKey: "above:expanded", estimatedHeight: 100 },
      { id: "visible", measurementKey: "visible:expanded", estimatedHeight: 100 },
      { id: "below", measurementKey: "below:expanded", estimatedHeight: 100 },
    ]);
    coordinator.setViewport(150, 100);

    const update = coordinator.measure([
      { id: "above", measurementKey: "above:expanded", height: 160, stable: true },
    ]);

    expect(update).toEqual({ accepted: 1, scrollTop: 210, scrollAdjustment: 60 });
    expect(coordinator.anchor()).toEqual({ id: "visible", viewportOffset: -50 });
    expect(coordinator.window().activeId).toBe("visible");
  });

  test("commits a batch of stable measurements with one semantic correction", () => {
    const coordinator = new ReviewVirtualCoordinator(0);
    coordinator.setItems([
      { id: "one", measurementKey: "one:expanded", estimatedHeight: 100 },
      { id: "two", measurementKey: "two:expanded", estimatedHeight: 100 },
      { id: "anchor", measurementKey: "anchor:expanded", estimatedHeight: 100 },
    ]);
    coordinator.setViewport(220, 80);

    const update = coordinator.measure([
      { id: "one", measurementKey: "one:expanded", height: 120, stable: true },
      { id: "two", measurementKey: "two:expanded", height: 130, stable: true },
      { id: "anchor", measurementKey: "anchor:expanded", height: 20, stable: false },
    ]);

    expect(update).toEqual({ accepted: 2, scrollTop: 270, scrollAdjustment: 50 });
    expect(coordinator.layoutVersion).toBe(2);
    expect(coordinator.item("anchor")?.height).toBe(100);
  });

  test("resolves navigation for an initially unmounted item", () => {
    const coordinator = new ReviewVirtualCoordinator(100);
    coordinator.setItems(Array.from({ length: 100 }, (_, index) => ({
      id: `file-${index}`,
      measurementKey: `file-${index}:expanded`,
      estimatedHeight: 100,
    })));
    coordinator.setViewport(0, 300);

    expect(coordinator.navigationTop("file-99")).toBe(9_700);
    expect(coordinator.window().items.some((item) => item.id === "file-99")).toBe(false);
  });
});
