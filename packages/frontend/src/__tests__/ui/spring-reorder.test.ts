import { describe, expect, test } from "bun:test";
import { reorderMoves } from "../../ui/spring-reorder.js";

describe("reorderMoves", () => {
  test("springs moved items from their old place, new ones in, and leaves still ones and gone ones alone", () => {
    const before = new Map([["a", 0], ["b", 40], ["c", 80], ["gone", 120]]);
    const after = new Map([["a", 0.4], ["c", 40], ["b", 80], ["new", 120]]);

    expect(reorderMoves(before, after)).toEqual(new Map<string, number | "enter">([["c", 40], ["b", -40], ["new", "enter"]]));
  });
});
