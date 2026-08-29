import { describe, expect, test } from "bun:test";
import {
  InlineReviewComments,
  normalizeReviewLineRange,
} from "../../../models/changes/inline-review-comments.js";

describe("InlineReviewComments", () => {
  test("normalizes same-side ranges and rejects cross-side selections", () => {
    expect(normalizeReviewLineRange({
      side: "old",
      startLine: 9,
      endLine: 4,
      endSide: "old",
    })).toEqual({ ok: true, range: { side: "old", startLine: 4, endLine: 9 } });

    expect(normalizeReviewLineRange({
      side: "old",
      startLine: 4,
      endLine: 9,
      endSide: "new",
    })).toEqual({ ok: false, error: "Inline comments must stay on one side of the diff." });
  });

  test("owns drafts and groups saved comments at one side and endpoint placement", () => {
    const comments = new InlineReviewComments();
    comments.reconcile("project:7:branch:task/example", [
      { fileId: "file-a", contentKey: "content-a" },
    ]);

    expect(comments.dispatch({
      type: "open-composer",
      fileId: "file-a",
      selection: { side: "new", startLine: 8, endLine: 5 },
    })).toEqual({ ok: true });
    comments.dispatch({ type: "update-draft", fileId: "file-a", body: "First note" });
    expect(comments.dispatch({ type: "save-comment", fileId: "file-a" })).toEqual({ ok: true });

    comments.dispatch({
      type: "open-composer",
      fileId: "file-a",
      selection: { side: "new", startLine: 5, endLine: 8 },
    });
    comments.dispatch({ type: "update-draft", fileId: "file-a", body: "Second note" });
    comments.dispatch({ type: "save-comment", fileId: "file-a" });

    const projection = comments.project("file-a");
    expect(projection.placements).toHaveLength(1);
    expect(projection.placements[0]).toMatchObject({
      side: "new",
      lineNumber: 8,
      range: { side: "new", startLine: 5, endLine: 8 },
    });
    expect(projection.placements[0]?.comments.map((comment) => comment.body)).toEqual([
      "First note",
      "Second note",
    ]);
    expect(projection.composer).toBeNull();

    const firstComment = projection.placements[0]?.comments[0];
    if (!firstComment) throw new Error("Expected saved comment");
    comments.dispatch({ type: "delete-comment", fileId: "file-a", commentId: firstComment.id });
    expect(comments.project("file-a").placements[0]?.comments.map((comment) => comment.body)).toEqual([
      "Second note",
    ]);
  });

  test("retains a non-empty draft across projections and virtual remounts", () => {
    const comments = new InlineReviewComments();
    comments.reconcile("scope", [{ fileId: "file-a", contentKey: "one" }]);
    comments.dispatch({
      type: "open-composer",
      fileId: "file-a",
      selection: { side: "old", startLine: 3, endLine: 3 },
    });
    comments.dispatch({ type: "update-draft", fileId: "file-a", body: "Still editing" });

    expect(comments.project("file-a").composer).toMatchObject({ body: "Still editing" });
    expect(comments.activeComposerFileId).toBe("file-a");

    comments.reconcile("scope", [{ fileId: "file-a", contentKey: "one" }]);
    expect(comments.project("file-a").composer).toMatchObject({ body: "Still editing" });

    comments.reconcile("scope", [{ fileId: "file-a", contentKey: "changed" }]);
    expect(comments.project("file-a").placements).toEqual([]);
    expect(comments.project("file-a").composer).toBeNull();
  });

  test("validates empty comments and cancels a draft without creating a thread", () => {
    const comments = new InlineReviewComments();
    comments.reconcile("scope", [{ fileId: "file-a", contentKey: "one" }]);
    comments.dispatch({
      type: "open-composer",
      fileId: "file-a",
      selection: { side: "new", startLine: 2, endLine: 2 },
    });

    expect(comments.dispatch({ type: "save-comment", fileId: "file-a" })).toEqual({
      ok: false,
      error: "Enter a comment before saving.",
    });
    expect(comments.project("file-a").composer?.error).toBe("Enter a comment before saving.");

    comments.dispatch({ type: "cancel-composer", fileId: "file-a" });
    expect(comments.project("file-a").placements).toEqual([]);
  });
});
