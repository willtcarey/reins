import { describe, expect, test } from "bun:test";
import {
  createReviewVirtualLayout,
  measureReviewVirtualLayout,
  reviewVirtualWindow,
} from "../../../models/changes/review-virtual-layout.js";

describe("review virtual layout", () => {
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
