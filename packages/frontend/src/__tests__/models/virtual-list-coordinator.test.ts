import { describe, expect, test } from "bun:test";
import { VirtualListCoordinator } from "../../models/virtual-list-coordinator.js";

describe("VirtualListCoordinator", () => {
  test("uses balanced bounded overscan while scrolling in either direction", () => {
    const coordinator = new VirtualListCoordinator(100);
    coordinator.setItems(Array.from({ length: 100 }, (_, index) => ({
      id: `item-${index}`,
      measurementKey: `item-${index}`,
      estimatedHeight: 100,
    })));

    coordinator.setViewport(2_000, 300);
    expect(coordinator.window().items.map((item) => item.id)).toEqual([
      "item-19",
      "item-20",
      "item-21",
      "item-22",
      "item-23",
    ]);

    coordinator.setViewport(1_800, 300);
    expect(coordinator.window().items.map((item) => item.id)).toEqual([
      "item-17",
      "item-18",
      "item-19",
      "item-20",
      "item-21",
    ]);
    expect(coordinator.window().items.length).toBeLessThanOrEqual(5);
  });

  test("preserves an item and viewport-offset anchor when geometry above changes", () => {
    const coordinator = new VirtualListCoordinator(0);
    coordinator.setItems([
      { id: "above", measurementKey: "above", estimatedHeight: 100 },
      { id: "visible", measurementKey: "visible", estimatedHeight: 100 },
      { id: "below", measurementKey: "below", estimatedHeight: 100 },
    ]);
    coordinator.setViewport(150, 100);

    const update = coordinator.measure([
      { id: "above", measurementKey: "above", height: 160 },
    ]);

    expect(update).toEqual({ accepted: 1, scrollTop: 210, scrollAdjustment: 60 });
    expect(coordinator.anchor()).toEqual({ id: "visible", viewportOffset: -50 });
    expect(coordinator.window().activeId).toBe("visible");
  });

  test("commits a measurement batch with one semantic correction", () => {
    const coordinator = new VirtualListCoordinator(0);
    coordinator.setItems([
      { id: "one", measurementKey: "one", estimatedHeight: 100 },
      { id: "two", measurementKey: "two", estimatedHeight: 100 },
      { id: "anchor", measurementKey: "anchor", estimatedHeight: 100 },
    ]);
    coordinator.setViewport(220, 80);

    const update = coordinator.measure([
      { id: "one", measurementKey: "one", height: 120 },
      { id: "two", measurementKey: "two", height: 130 },
    ]);

    expect(update).toEqual({ accepted: 2, scrollTop: 270, scrollAdjustment: 50 });
    expect(coordinator.layoutVersion).toBe(2);
    expect(coordinator.item("anchor")?.height).toBe(100);
  });

  test("owns leading gaps independently from estimated, measured, and fixed content heights", () => {
    const coordinator = new VirtualListCoordinator(0);
    coordinator.setItems([
      { id: "first", measurementKey: "first", estimatedHeight: 100 },
      { id: "second", measurementKey: "second", estimatedHeight: 100, gapBefore: 16 },
      { id: "third", measurementKey: "third", estimatedHeight: 100, gapBefore: 16 },
    ]);

    expect(coordinator.item("second")).toMatchObject({ top: 100, gapBefore: 16, height: 116 });
    expect(coordinator.item("third")?.top).toBe(216);

    coordinator.measure([{ id: "second", measurementKey: "second", height: 140 }]);
    expect(coordinator.item("second")?.height).toBe(156);
    expect(coordinator.item("third")?.top).toBe(256);

    coordinator.setItems([
      { id: "first", measurementKey: "first", estimatedHeight: 100 },
      { id: "second", measurementKey: "second", estimatedHeight: 100, gapBefore: 16, fixedHeight: 37 },
      { id: "third", measurementKey: "third", estimatedHeight: 100, gapBefore: 16 },
    ]);
    expect(coordinator.item("second")?.height).toBe(53);
    expect(coordinator.item("third")?.top).toBe(153);
  });

  test("uses fixed geometry without replacing the fluid measurement", () => {
    const coordinator = new VirtualListCoordinator(0);
    coordinator.setItems([
      { id: "item", measurementKey: "item-content", estimatedHeight: 100 },
    ]);

    expect(coordinator.measure([
      { id: "item", measurementKey: "item-content", height: 180 },
    ]).accepted).toBe(1);
    expect(coordinator.item("item")?.height).toBe(180);

    coordinator.setItems([{
      id: "item",
      measurementKey: "item-content",
      estimatedHeight: 100,
      fixedHeight: 37,
    }]);
    expect(coordinator.item("item")?.height).toBe(37);
    expect(coordinator.measure([
      { id: "item", measurementKey: "item-content", height: 41 },
    ]).accepted).toBe(0);

    coordinator.setItems([
      { id: "item", measurementKey: "item-content", estimatedHeight: 100 },
    ]);
    expect(coordinator.item("item")?.height).toBe(180);
  });

  test("resolves navigation for an initially unmounted item", () => {
    const coordinator = new VirtualListCoordinator(100);
    coordinator.setItems(Array.from({ length: 100 }, (_, index) => ({
      id: `item-${index}`,
      measurementKey: `item-${index}`,
      estimatedHeight: 100,
    })));
    coordinator.setViewport(0, 300);

    expect(coordinator.navigationTop("item-99")).toBe(9_700);
    expect(coordinator.window().items.some((item) => item.id === "item-99")).toBe(false);
  });
});
