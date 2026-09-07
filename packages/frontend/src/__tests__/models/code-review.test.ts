import { describe, expect, test } from "bun:test";
import {
  buildReviewAnnotation,
  reviewPlacements,
  type CodeReviewState,
  type ReviewedFile,
} from "../../models/code-review.js";

const FILE: ReviewedFile = {
  id: "file-a",
  contentKey: "content-a",
  path: "src/example.ts",
  oldPath: null,
  lineText: (_side, line) => ["first", "second", "third"][line - 1] ?? null,
};

const STATE: CodeReviewState = {
  id: "review-1", projectId: 7, taskId: 11, revision: 1,
  annotations: [{
    id: "annotation-1",
    anchor: { path: FILE.path, oldPath: null, side: "new", startLine: 2, endLine: 2,
      excerpt: "original", contextBefore: "first", contextAfter: "third",
      fileFingerprint: "older", baseRevision: null, headRevision: null },
    entries: [{ id: "entry-1", author: "Reviewer", body: "Note", createdAt: "2026-01-01" }],
  }],
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};

describe("code review", () => {
  test("projects saved entries by current path and existing range", () => {
    expect(reviewPlacements(STATE, FILE)).toEqual([{
      id: "file-a:new:2",
      range: { side: "new", startLine: 2, endLine: 2 },
      comments: [{ id: "entry-1", author: "Reviewer", body: "Note" }],
    }]);
    expect(reviewPlacements(STATE, { ...FILE, lineText: () => null })).toEqual([]);
  });

  test("builds original anchor evidence from a normalized valid range", () => {
    const annotation = buildReviewAnnotation(FILE, { side: "new", startLine: 2, endLine: 3 }, {
      id: "entry-2", annotationId: "annotation-2", author: "You", body: "Explain", createdAt: "2026-01-02",
    });
    expect(annotation).toMatchObject({
      id: "annotation-2",
      anchor: { path: FILE.path, side: "new", startLine: 2, endLine: 3, excerpt: "second\nthird", contextBefore: "first", contextAfter: null, fileFingerprint: "content-a" },
      entry: { id: "entry-2", body: "Explain" },
    });
    expect(() => buildReviewAnnotation(FILE, { side: "new", startLine: 3, endLine: 4 }, {
      id: "x", annotationId: "y", author: "You", body: "bad", createdAt: "now",
    })).toThrow("range is no longer available");
  });
});
