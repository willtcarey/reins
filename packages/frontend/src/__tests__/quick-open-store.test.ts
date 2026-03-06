/**
 * Tests for quick-open store fuzzy matching and filtering.
 */
import { describe, test, expect } from "bun:test";
import { fuzzyMatch, filterItems, itemSearchText, type PaletteItem } from "../stores/quick-open-store.js";

// ---- fuzzyMatch -------------------------------------------------------------

describe("fuzzyMatch", () => {
  test("exact substring match returns 0", () => {
    const score = fuzzyMatch("hello", "hello world");
    expect(score).toBe(0);
  });

  test("exact full match returns 0", () => {
    expect(fuzzyMatch("abc", "abc")).toBe(0);
  });

  test("fuzzy match with gaps returns positive score", () => {
    const score = fuzzyMatch("hlo", "hello");
    // h(0) e l(2) l o(4) — matches h at 0, l at 2, o at 4
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
  });

  test("case insensitive matching", () => {
    expect(fuzzyMatch("ABC", "abcdef")).toBe(0);
    expect(fuzzyMatch("abc", "ABCDEF")).toBe(0);
    expect(fuzzyMatch("HeLLo", "hello")).toBe(0);
  });

  test("no match returns null", () => {
    expect(fuzzyMatch("xyz", "hello")).toBeNull();
  });

  test("query longer than text returns null", () => {
    expect(fuzzyMatch("abcdef", "abc")).toBeNull();
  });

  test("empty query matches everything with score 0", () => {
    expect(fuzzyMatch("", "anything")).toBe(0);
    expect(fuzzyMatch("", "")).toBe(0);
  });

  test("characters out of order returns null", () => {
    expect(fuzzyMatch("ba", "abc")).toBeNull();
  });

  test("consecutive match scores lower than spread match", () => {
    const consecutive = fuzzyMatch("ab", "ab_____");
    const spread = fuzzyMatch("ab", "a____b");
    expect(consecutive).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(consecutive!).toBeLessThan(spread!);
  });
});

// ---- filterItems ------------------------------------------------------------

function makeItem(overrides: Partial<PaletteItem> & { sessionId: string }): PaletteItem {
  return {
    projectId: 1,
    projectName: "Project",
    taskId: null,
    taskTitle: null,
    firstMessage: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("itemSearchText", () => {
  test("uses 'Assistant' when taskTitle is null", () => {
    const item = makeItem({ sessionId: "s1" });
    expect(itemSearchText(item)).toBe("Project Assistant ");
  });

  test("uses taskTitle when present", () => {
    const item = makeItem({ sessionId: "s1", taskTitle: "Fix bug" });
    expect(itemSearchText(item)).toBe("Project Fix bug ");
  });

  test("includes firstMessage", () => {
    const item = makeItem({ sessionId: "s1", firstMessage: "Hello there" });
    expect(itemSearchText(item)).toBe("Project Assistant Hello there");
  });
});

describe("filterItems", () => {
  const items: PaletteItem[] = [
    makeItem({ sessionId: "s1", projectName: "Alpha", taskTitle: "Build UI", firstMessage: "Start here" }),
    makeItem({ sessionId: "s2", projectName: "Beta", taskTitle: null, firstMessage: "Fix the bug" }),
    makeItem({ sessionId: "s3", projectName: "Gamma", taskTitle: "Deploy", firstMessage: null }),
  ];

  test("empty query returns all items in original order", () => {
    const result = filterItems(items, "");
    expect(result).toEqual(items);
  });

  test("whitespace-only query returns all items", () => {
    const result = filterItems(items, "   ");
    expect(result).toEqual(items);
  });

  test("filters by project name", () => {
    const result = filterItems(items, "Alpha");
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe("s1");
  });

  test("filters by task title", () => {
    const result = filterItems(items, "Deploy");
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe("s3");
  });

  test("filters by 'Assistant' for null task", () => {
    const result = filterItems(items, "Assistant");
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe("s2");
  });

  test("filters by first message", () => {
    const result = filterItems(items, "bug");
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe("s2");
  });

  test("fuzzy filtering works", () => {
    // "BUI" should match "Build UI" in s1
    const result = filterItems(items, "BUI");
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].sessionId).toBe("s1");
  });

  test("no match returns empty array", () => {
    const result = filterItems(items, "zzzzz");
    expect(result).toEqual([]);
  });

  test("tighter matches rank higher", () => {
    const testItems: PaletteItem[] = [
      makeItem({ sessionId: "spread", projectName: "a_x_y_b_c", taskTitle: "test" }),
      makeItem({ sessionId: "tight", projectName: "abc", taskTitle: "test" }),
    ];
    const result = filterItems(testItems, "abc");
    expect(result[0].sessionId).toBe("tight");
  });

  test("empty query reorders by recentIds", () => {
    const result = filterItems(items, "", ["s3", "s1"]);
    expect(result.map((i) => i.sessionId)).toEqual(["s3", "s1", "s2"]);
  });

  test("recentIds with unknown IDs are ignored", () => {
    const result = filterItems(items, "", ["unknown", "s2"]);
    expect(result.map((i) => i.sessionId)).toEqual(["s2", "s1", "s3"]);
  });

  test("recentIds don't affect search results", () => {
    const result = filterItems(items, "Deploy", ["s1", "s2"]);
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe("s3");
  });
});
