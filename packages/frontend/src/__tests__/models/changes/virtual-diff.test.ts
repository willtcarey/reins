import { describe, expect, test } from "bun:test";
import { buildVirtualDiffRows, parseVirtualDiffPatch } from "../../../models/changes/virtual-diff.js";

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

describe("virtual diff model", () => {
  test("parses a full patch into renderer-specific items with stable ids and cache keys", () => {
    const result = parseVirtualDiffPatch(SAMPLE_PATCH, { cacheKeyPrefix: "project-7" });

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

  test("builds unified rows from parsed @pierre/diffs metadata", () => {
    const result = parseVirtualDiffPatch(SAMPLE_PATCH, { cacheKeyPrefix: "project-7" });
    const rows = buildVirtualDiffRows(result.items[0]!.fileDiff);

    expect(rows.map((row) => ({ type: row.type, text: row.text, oldLine: row.oldLine, newLine: row.newLine }))).toEqual([
      { type: "hunk", text: "@@ -1,4 +1,4 @@", oldLine: undefined, newLine: undefined },
      { type: "context", text: "export function greet() {\n", oldLine: 1, newLine: 1 },
      { type: "deletion", text: "  return \"hello\";\n", oldLine: 2, newLine: undefined },
      { type: "addition", text: "  return \"hi\";\n", oldLine: undefined, newLine: 2 },
      { type: "context", text: "}\n", oldLine: 3, newLine: 3 },
      { type: "context", text: "\n", oldLine: 4, newLine: 4 },
    ]);
  });
});
