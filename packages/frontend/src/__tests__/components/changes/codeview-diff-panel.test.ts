import { describe, expect, test } from "bun:test";
import { parseCodeViewDiffPatch, toCodeViewItems } from "../../../components/changes/codeview-diff-panel.js";

const SAMPLE_PATCH = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,4 +1,4 @@
 export function greet() {
-  return "hello";
+  return "hi";
 }
 
`;

describe("CodeViewDiffPanel helpers", () => {
  test("parses a full patch into renderer-specific items with stable ids and cache keys", () => {
    const result = parseCodeViewDiffPatch(SAMPLE_PATCH, { cacheKeyPrefix: "project-7" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "diff:src%2Fexample.ts:0",
      type: "diff",
      path: "src/example.ts",
      version: 1,
    });
    expect(result.items[0]?.fileDiff.cacheKey).toBe("project-7-0-0");
    expect(result.pathToItemId.get("src/example.ts")).toBe("diff:src%2Fexample.ts:0");
  });

  test("sorts parsed items in the same directory-first order as the file sidebar", () => {
    const patch = `diff --git a/bun.lock b/bun.lock
index 1111111..2222222 100644
--- a/bun.lock
+++ b/bun.lock
@@ -1 +1 @@
-old
+new
diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-old
+new
`;

    const result = parseCodeViewDiffPatch(patch, { cacheKeyPrefix: "project-7" });

    expect(result.items.map((item) => item.path)).toEqual(["src/example.ts", "bun.lock"]);
  });

  test("converts parsed items to Pierre CodeView diff items", () => {
    const result = parseCodeViewDiffPatch(SAMPLE_PATCH, { cacheKeyPrefix: "project-7" });
    const items = toCodeViewItems(result.items);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "diff:src%2Fexample.ts:0",
      type: "diff",
      version: 1,
      collapsed: false,
    });
    expect(items[0]?.fileDiff.name).toBe("src/example.ts");
    expect(items[0]?.fileDiff.cacheKey).toBe("project-7-0-0");
  });
});
