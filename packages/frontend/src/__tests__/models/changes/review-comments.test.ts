import { describe, expect, test } from "bun:test";
import {
  ReviewComments,
  normalizeReviewLineRange,
  type ReviewCommentsPersistence,
} from "../../../models/changes/review-comments.js";
import type {
  CodeReviewState,
  NewReviewAnnotation,
} from "../../../models/stores/code-review-store.js";

describe("ReviewComments", () => {
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
    const comments = new ReviewComments();
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
    const comments = new ReviewComments();
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

  test("keeps a saved comment at its line number when the reviewed file changes", () => {
    const persistence: ReviewCommentsPersistence = {
      review: {
        id: "review-1",
        projectId: 7,
        taskId: 11,
        revision: 1,
        annotations: [{
          id: "annotation-1",
          anchor: {
            path: "src/example.ts",
            oldPath: null,
            side: "new",
            startLine: 2,
            endLine: 2,
            excerpt: "original text",
            contextBefore: null,
            contextAfter: null,
            fileFingerprint: "old-content",
            baseRevision: null,
            headRevision: null,
          },
          entries: [{
            id: "entry-1",
            author: "You",
            body: "Still show this",
            createdAt: "2026-08-30T10:00:00.000Z",
          }],
        }],
        createdAt: "2026-08-30T10:00:00.000Z",
        updatedAt: "2026-08-30T10:00:00.000Z",
      },
      subscribe: () => () => {},
      async addAnnotation() { throw new Error("Not used"); },
    };
    const comments = new ReviewComments(persistence);

    comments.reconcile("scope", [{
      fileId: "file-a",
      contentKey: "new-content",
      path: "src/example.ts",
      lineText: (_side, line) => line === 2 ? "changed text" : null,
    }]);

    expect(comments.project("file-a").placements[0]).toMatchObject({
      lineNumber: 2,
      comments: [{ body: "Still show this" }],
    });

    comments.reconcile("scope", [{
      fileId: "file-a",
      contentKey: "newer-content",
      path: "src/example.ts",
      lineText: () => null,
    }]);

    expect(comments.project("file-a").placements).toEqual([]);
  });

  test("loads server annotations and saves new comments through the review store", async () => {
    let review: CodeReviewState | null = {
      id: "review-1",
      projectId: 7,
      taskId: 11,
      revision: 1,
      annotations: [{
        id: "annotation-existing",
        anchor: {
          path: "src/example.ts",
          oldPath: null,
          side: "new",
          startLine: 2,
          endLine: 2,
          excerpt: "new line",
          contextBefore: "first line",
          contextAfter: null,
          fileFingerprint: "content-a",
          baseRevision: null,
          headRevision: null,
        },
        entries: [{
          id: "entry-existing",
          author: "Reviewer",
          body: "Existing note",
          createdAt: "2026-08-30T10:00:00.000Z",
        }],
      }],
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
    };
    const saved: NewReviewAnnotation[] = [];
    const listeners = new Set<() => void>();
    const persistence: ReviewCommentsPersistence = {
      get review() { return review; },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async addAnnotation(annotation) {
        saved.push(annotation);
        review = {
          ...review!,
          revision: 2,
          annotations: [...review!.annotations, {
            id: annotation.id,
            anchor: annotation.anchor,
            entries: [annotation.entry],
          }],
        };
        for (const listener of listeners) listener();
        return review;
      },
    };
    const comments = new ReviewComments(persistence);
    comments.reconcile("scope", [{
      fileId: "file-a",
      contentKey: "content-a",
      path: "src/example.ts",
      oldPath: null,
      lineText: (_side, line) => ["first line", "new line", "last line"][line - 1] ?? null,
    }]);

    expect(comments.project("file-a").placements[0]?.comments[0]).toMatchObject({
      id: "entry-existing",
      author: "Reviewer",
      body: "Existing note",
    });

    await comments.dispatch({
      type: "open-composer",
      fileId: "file-a",
      selection: { side: "new", startLine: 3, endLine: 3 },
    });
    await comments.dispatch({ type: "update-draft", fileId: "file-a", body: "New note" });
    await comments.dispatch({ type: "save-comment", fileId: "file-a" });

    expect(saved[0]).toMatchObject({
      anchor: {
        path: "src/example.ts",
        oldPath: null,
        side: "new",
        startLine: 3,
        endLine: 3,
        excerpt: "last line",
        contextBefore: "new line",
        contextAfter: null,
        fileFingerprint: "content-a",
      },
      entry: { author: "You", body: "New note" },
    });
    expect(comments.project("file-a").placements.flatMap((placement) => placement.comments).map((comment) => comment.body)).toEqual([
      "Existing note",
      "New note",
    ]);
  });

  test("validates empty comments and cancels a draft without creating a thread", () => {
    const comments = new ReviewComments();
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
