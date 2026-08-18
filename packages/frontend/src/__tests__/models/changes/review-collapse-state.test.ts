import { describe, expect, test } from "bun:test";
import {
  ReviewCollapseState,
  type KeyValueStorage,
  type ReviewCollapseScope,
} from "../../../models/changes/review-collapse-state.js";
import { parseReviewItems } from "../../../models/changes/review-items.js";

const PATCH_A = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-old
+first
`;

const PATCH_B = PATCH_A.replace("+first", "+second");
const SCOPE: ReviewCollapseScope = {
  projectId: 7,
  branch: "task/example",
};

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("review collapse state", () => {
  test("reads a reviewed file across renderer instances", () => {
    const storage = new MemoryStorage();
    const initial = parseReviewItems(PATCH_A, "project-7-v1");
    const item = initial.items[0]!;

    const collapseState = new ReviewCollapseState(storage);
    collapseState.setCollapsed(SCOPE, item, true);
    const reparsed = parseReviewItems(PATCH_A, "project-7-v2").items[0]!;

    expect(collapseState.isCollapsed(SCOPE, reparsed)).toBe(true);
  });

  test("invalidates the reviewed version when content changes so a later revert stays expanded", () => {
    const storage = new MemoryStorage();
    const collapseState = new ReviewCollapseState(storage);
    const original = parseReviewItems(PATCH_A, "project-7-v1").items[0]!;
    collapseState.setCollapsed(SCOPE, original, true);

    const changed = parseReviewItems(PATCH_B, "project-7-v2").items[0]!;
    const reverted = parseReviewItems(PATCH_A, "project-7-v3").items[0]!;

    expect(collapseState.isCollapsed(SCOPE, changed)).toBe(false);
    expect(storage.values.size).toBe(0);
    expect(collapseState.isCollapsed(SCOPE, reverted)).toBe(false);
  });

  test("stores only the latest reviewed hash for each scoped file", () => {
    const storage = new MemoryStorage();
    const collapseState = new ReviewCollapseState(storage);
    const first = parseReviewItems(PATCH_A, "project-7-v1").items[0]!;
    const second = parseReviewItems(PATCH_B, "project-7-v2").items[0]!;

    collapseState.setCollapsed(SCOPE, first, true);
    const firstHash = [...storage.values.values()][0];
    collapseState.setCollapsed(SCOPE, second, true);

    expect(storage.values.size).toBe(1);
    expect([...storage.values.values()][0]).not.toBe(firstHash);
  });

  test("uses the same reviewed state across diff modes", () => {
    const storage = new MemoryStorage();
    const collapseState = new ReviewCollapseState(storage);
    const item = parseReviewItems(PATCH_A, "project-7-v1").items[0]!;
    collapseState.setCollapsed(SCOPE, item, true);

    const reparsed = parseReviewItems(PATCH_A, "project-7-uncommitted-v1").items[0]!;

    expect([...storage.values.keys()][0]).toBe(
      `reins:reviewed-diff:[7,"task/example","${item.id}"]`,
    );
    expect(collapseState.isCollapsed(SCOPE, reparsed)).toBe(true);
    expect(storage.values.size).toBe(1);
  });

  test("does not share reviewed state between projects", () => {
    const storage = new MemoryStorage();
    const collapseState = new ReviewCollapseState(storage);
    const item = parseReviewItems(PATCH_A, "project-7-v1").items[0]!;
    collapseState.setCollapsed(SCOPE, item, true);

    const reparsed = parseReviewItems(PATCH_A, "project-8-v1").items[0]!;

    expect(collapseState.isCollapsed({ ...SCOPE, projectId: 8 }, reparsed)).toBe(false);
  });
});
