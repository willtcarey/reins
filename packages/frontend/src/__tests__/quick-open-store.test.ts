/**
 * Tests for quick-open store filtering.
 */
import { describe, expect, mock, test } from "bun:test";
import type { PaletteItem } from "@backend/session-store.js";
import {
  QuickOpenStore,
  filterItems,
  itemSearchText,
} from "../models/stores/quick-open-store.js";
import { SessionCache } from "../models/stores/session-cache.js";

describe("QuickOpenStore activity", () => {
  test("looks up activity by session ID and notifies only when activity changes", () => {
    const sessions = new SessionCache();
    sessions.set("s1", { projectId: 42, activityState: null });
    const store = new QuickOpenStore(sessions);
    const listener = mock(() => {});
    store.subscribe(listener);

    expect(store.activityForSession("s1")).toBeNull();

    sessions.set("s1", { name: "Renamed" });
    expect(listener).not.toHaveBeenCalled();

    sessions.set("s1", { activityState: "running" });
    expect(store.activityForSession("s1")).toBe("running");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("stops reacting to activity after disposal", () => {
    const sessions = new SessionCache();
    const store = new QuickOpenStore(sessions);
    const listener = mock(() => {});
    store.subscribe(listener);

    store.dispose();
    sessions.set("s1", { activityState: "finished" });

    expect(listener).not.toHaveBeenCalled();
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
