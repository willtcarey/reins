import { describe, expect, test } from "bun:test";
import {
  parseReviewItems,
  reconcileReviewItems,
} from "../../../models/changes/review-items.js";

const PATCH = `diff --git a/src/old.ts b/src/new.ts
similarity index 88%
rename from src/old.ts
rename to src/new.ts
index 1111111..2222222 100644
--- a/src/old.ts
+++ b/src/new.ts
@@ -1 +1 @@
-old
+new
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/README.md
@@ -0,0 +1 @@
+# Hello
`;

describe("parseReviewItems", () => {
  test("creates sorted Reins review records with identity and Pierre cache keys", () => {
    const result = parseReviewItems(PATCH, "project-7-v3");

    expect(result.items.map((item) => item.path)).toEqual(["src/new.ts", "README.md"]);
    expect(result.items[0]).toMatchObject({
      id: "review:rename-changed:src%2Fold.ts:src%2Fnew.ts:0",
      kind: "diff",
      path: "src/new.ts",
      oldPath: "src/old.ts",
      status: "rename-changed",
      additions: 1,
      removals: 1,
      occurrence: 0,
    });
    expect(result.items[0]?.cacheKey).toBe("project-7-v3:rename-changed:src%2Fold.ts:src%2Fnew.ts:0");
    expect(result.items[0]?.fileDiff.cacheKey).toBe(result.items[0]?.cacheKey);
    expect(result.pathToItemId.get("src/new.ts")).toBe(result.items[0]?.id);
    expect(result.pathToItemId.get("src/old.ts")).toBe(result.items[0]?.id);
  });

  test("reuses unchanged records and replaces changed surviving records", () => {
    const initial = parseReviewItems(PATCH, "project-7-v1");
    const refreshed = parseReviewItems(PATCH.replace("+# Hello", "+# Hello world"), "project-7-v2");

    const reconciled = reconcileReviewItems(initial, refreshed);
    const initialRenamed = initial.items.find((item) => item.path === "src/new.ts")!;
    const initialReadme = initial.items.find((item) => item.path === "README.md")!;
    const reconciledReadme = reconciled.items.find((item) => item.path === "README.md")!;

    expect(reconciled.items.find((item) => item.path === "src/new.ts")).toBe(initialRenamed);
    expect(reconciledReadme).not.toBe(initialReadme);
    expect(reconciled.pathToItemId).toBe(refreshed.pathToItemId);
  });

  test("reuses every record when a refresh returns the same patch", () => {
    const initial = parseReviewItems(PATCH, "project-7-v1");
    const refreshed = parseReviewItems(PATCH, "project-7-v2");

    const reconciled = reconcileReviewItems(initial, refreshed);

    expect(reconciled.items).toEqual(initial.items);
    expect(reconciled.items[0]).toBe(initial.items[0]);
    expect(reconciled.items[1]).toBe(initial.items[1]);
  });

  test("uses occurrence to keep duplicate records unique and reports malformed patches", () => {
    const duplicatePatch = `${PATCH}${PATCH}`;
    const duplicate = parseReviewItems(duplicatePatch, "snapshot");

    expect(new Set(duplicate.items.map((item) => item.id)).size).toBe(duplicate.items.length);
    expect(duplicate.items.filter((item) => item.path === "src/new.ts").map((item) => item.occurrence)).toEqual([0, 1]);

    const malformed = parseReviewItems("diff --git a/a.ts b/a.ts\n@@ invalid\n+x", "snapshot");
    expect(malformed.items).toEqual([]);
    expect(malformed.parseError).toBeTruthy();
  });
});
