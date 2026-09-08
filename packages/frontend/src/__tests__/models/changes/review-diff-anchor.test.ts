import { describe, expect, test } from "bun:test";
import { processFile } from "@pierre/diffs";
import { reviewDiffLines } from "../../../models/changes/review-diff-anchor.js";

describe("review diff anchor", () => {
  test("captures side-specific context and changed rows", () => {
    const fileDiff = processFile(`diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -1,3 +1,3 @@
 same
-old
+new
 tail
`);
    if (!fileDiff) throw new Error("Expected parsed diff");

    expect(reviewDiffLines(fileDiff, "old")).toEqual([
      { kind: "context", line: 1, text: "same" },
      { kind: "deletion", line: 2, text: "old" },
      { kind: "context", line: 3, text: "tail" },
    ]);
    expect(reviewDiffLines(fileDiff, "new")).toEqual([
      { kind: "context", line: 1, text: "same" },
      { kind: "addition", line: 2, text: "new" },
      { kind: "context", line: 3, text: "tail" },
    ]);
  });
});
