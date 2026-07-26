import { describe, expect, test } from "bun:test";
import { parseVirtualizedReviewItems } from "../../../models/changes/virtualized-review-items.js";

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

describe("parseVirtualizedReviewItems", () => {
  test("creates sorted Reins review records with identity and Pierre cache keys", () => {
    const result = parseVirtualizedReviewItems(PATCH, "project-7-v3", 3);

    expect(result.items.map((item) => item.path)).toEqual(["src/new.ts", "README.md"]);
    expect(result.items[0]).toMatchObject({
      id: "review:rename-changed:src%2Fold.ts:src%2Fnew.ts:0",
      kind: "diff",
      path: "src/new.ts",
      oldPath: "src/old.ts",
      status: "rename-changed",
      occurrence: 0,
      version: 3,
      state: { collapsed: false, activeTab: "diff", parseError: null },
    });
    expect(result.items[0]?.cacheKey).toBe("project-7-v3:rename-changed:src%2Fold.ts:src%2Fnew.ts:0");
    expect(result.items[0]?.fileDiff.cacheKey).toBe(result.items[0]?.cacheKey);
    expect(result.pathToItemId.get("src/new.ts")).toBe(result.items[0]?.id);
    expect(result.pathToItemId.get("src/old.ts")).toBe(result.items[0]?.id);
  });

  test("uses occurrence to keep duplicate records unique and reports malformed patches", () => {
    const duplicatePatch = `${PATCH}${PATCH}`;
    const duplicate = parseVirtualizedReviewItems(duplicatePatch, "snapshot", 1);

    expect(new Set(duplicate.items.map((item) => item.id)).size).toBe(duplicate.items.length);
    expect(duplicate.items.filter((item) => item.path === "src/new.ts").map((item) => item.occurrence)).toEqual([0, 1]);

    const malformed = parseVirtualizedReviewItems("diff --git a/a.ts b/a.ts\n@@ invalid\n+x", "snapshot", 1);
    expect(malformed.items).toEqual([]);
    expect(malformed.parseError).toBeTruthy();
  });
});
