import { describe, expect, test } from "bun:test";
import {
  ReviewCollapseState,
  type KeyValueStorage,
  type ReviewCollapseScope,
} from "../../../models/changes/review-collapse-state.js";
import { parseFileChanges } from "../../../models/changes/file-changes.js";

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
    const initial = parseFileChanges(PATCH_A, "project-7-v1");
    const change = initial.changes[0]!;

    const collapseState = new ReviewCollapseState(storage);
    collapseState.setCollapsed(SCOPE, change, true);
    const reparsed = parseFileChanges(PATCH_A, "project-7-v2").changes[0]!;

    expect(collapseState.isCollapsed(SCOPE, reparsed)).toBe(true);
  });

  test("invalidates the reviewed version when content changes so a later revert stays expanded", () => {
    const storage = new MemoryStorage();
    const collapseState = new ReviewCollapseState(storage);
    const original = parseFileChanges(PATCH_A, "project-7-v1").changes[0]!;
    collapseState.setCollapsed(SCOPE, original, true);

    const changed = parseFileChanges(PATCH_B, "project-7-v2").changes[0]!;
    const reverted = parseFileChanges(PATCH_A, "project-7-v3").changes[0]!;

    expect(collapseState.isCollapsed(SCOPE, changed)).toBe(false);
    expect(storage.values.size).toBe(0);
    expect(collapseState.isCollapsed(SCOPE, reverted)).toBe(false);
  });

  test("stores only the latest reviewed hash for each scoped file", () => {
    const storage = new MemoryStorage();
    const collapseState = new ReviewCollapseState(storage);
    const first = parseFileChanges(PATCH_A, "project-7-v1").changes[0]!;
    const second = parseFileChanges(PATCH_B, "project-7-v2").changes[0]!;

    collapseState.setCollapsed(SCOPE, first, true);
    const firstHash = [...storage.values.values()][0];
    collapseState.setCollapsed(SCOPE, second, true);

    expect(storage.values.size).toBe(1);
    expect([...storage.values.values()][0]).not.toBe(firstHash);
  });

  test("uses the same reviewed state across diff modes", () => {
    const storage = new MemoryStorage();
    const collapseState = new ReviewCollapseState(storage);
    const change = parseFileChanges(PATCH_A, "project-7-v1").changes[0]!;
    collapseState.setCollapsed(SCOPE, change, true);

    const reparsed = parseFileChanges(PATCH_A, "project-7-uncommitted-v1").changes[0]!;

    expect([...storage.values.keys()][0]).toBe(
      `reins:reviewed-diff:[7,"task/example","${change.id}"]`,
    );
    expect(collapseState.isCollapsed(SCOPE, reparsed)).toBe(true);
    expect(storage.values.size).toBe(1);
  });

  test("does not share reviewed state between projects", () => {
    const storage = new MemoryStorage();
    const collapseState = new ReviewCollapseState(storage);
    const change = parseFileChanges(PATCH_A, "project-7-v1").changes[0]!;
    collapseState.setCollapsed(SCOPE, change, true);

    const reparsed = parseFileChanges(PATCH_A, "project-8-v1").changes[0]!;

    expect(collapseState.isCollapsed({ ...SCOPE, projectId: 8 }, reparsed)).toBe(false);
  });
});
