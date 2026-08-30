import { describe, expect, mock, test } from "bun:test";
import { createProject } from "../project-store.js";
import { createTask } from "../task-store.js";
import { createCodeReview, getCodeReview, saveCodeReview } from "../code-review-store.js";
import type { Broadcast, ServerMessage } from "../models/broadcast.js";
import {
  CodeReviewMutationConflictError,
  addCodeReviewAnnotation,
} from "../code-review-workflow.js";
import { useTestDb } from "./helpers/test-db.js";

const annotation = {
  id: "annotation-client-1",
  anchor: {
    path: "src/example.ts",
    oldPath: null,
    side: "new" as const,
    startLine: 4,
    endLine: 4,
    excerpt: "return value;",
    contextBefore: null,
    contextAfter: null,
    fileFingerprint: "file-v1",
    baseRevision: "base-sha",
    headRevision: "head-sha",
  },
  entry: {
    id: "entry-client-1",
    author: "Reviewer",
    body: "Please explain this.",
    createdAt: "2026-08-30T10:00:00.000Z",
  },
};

describe("code review annotation workflow", () => {
  useTestDb();

  test("atomically creates the scoped review, saves its annotation, then broadcasts invalidation", () => {
    const projectId = createProject("Review Project", "/tmp/review-project").id;
    const taskId = createTask(projectId, "Review task", null, "task/review").id;
    const messages: ServerMessage[] = [];
    const broadcast: Broadcast = mock((message) => {
      const persisted = getCodeReview(message.type === "code_review_updated" ? message.reviewId : "");
      expect(persisted?.revision).toBe(1);
      messages.push(message);
    });

    const result = addCodeReviewAnnotation({ projectId, taskId, annotation }, broadcast);

    expect(result.created).toBe(true);
    expect(result.review).toMatchObject({ projectId, taskId, status: "open", revision: 1 });
    expect(result.review.annotations).toEqual([{ id: annotation.id, anchor: annotation.anchor, entries: [annotation.entry] }]);
    expect(messages).toEqual([{
      type: "code_review_updated",
      projectId,
      taskId,
      reviewId: result.review.id,
      revision: 1,
      status: "open",
    }]);
  });

  test("returns an idempotent retry with the original now-stale known revision without saving or broadcasting again", () => {
    const projectId = createProject("Review Project", "/tmp/review-project").id;
    const taskId = createTask(projectId, "Review task", null, "task/review").id;
    const broadcast = mock<Broadcast>(() => {});
    const open = createCodeReview({ id: "review-existing", projectId, taskId });
    const first = addCodeReviewAnnotation({
      projectId,
      taskId,
      reviewId: open.id,
      revision: open.revision,
      annotation,
    }, broadcast);

    addCodeReviewAnnotation({
      projectId,
      taskId,
      reviewId: first.review.id,
      revision: first.review.revision,
      annotation: {
        ...annotation,
        id: "annotation-client-2",
        entry: { ...annotation.entry, id: "entry-client-2", body: "A later comment" },
      },
    }, broadcast);

    const retried = addCodeReviewAnnotation({
      projectId,
      taskId,
      reviewId: open.id,
      revision: open.revision,
      annotation,
    }, broadcast);

    expect(retried).toMatchObject({ created: false });
    expect(retried.review).toMatchObject({ id: first.review.id, revision: 2 });
    expect(retried.review.annotations).toHaveLength(2);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  test("conflicts when a stale retry reuses its identities with different content", () => {
    const projectId = createProject("Review Project", "/tmp/review-project").id;
    const taskId = createTask(projectId, "Review task", null, "task/review").id;
    const broadcast = mock<Broadcast>(() => {});
    const first = addCodeReviewAnnotation({ projectId, taskId, annotation }, broadcast);

    expect(() => addCodeReviewAnnotation({
      projectId,
      taskId,
      reviewId: first.review.id,
      revision: 0,
      annotation: { ...annotation, entry: { ...annotation.entry, body: "Changed on retry" } },
    }, broadcast)).toThrow(CodeReviewMutationConflictError);
    expect(getCodeReview(first.review.id)?.annotations[0]?.entries[0]?.body)
      .toBe(annotation.entry.body);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  test("conflicts rather than switching reviews for stale new mutations or terminal known reviews", () => {
    const projectId = createProject("Review Project", "/tmp/review-project").id;
    const taskId = createTask(projectId, "Review task", null, "task/review").id;
    const broadcast = mock<Broadcast>(() => {});
    const first = addCodeReviewAnnotation({ projectId, taskId, annotation }, broadcast);

    expect(() => addCodeReviewAnnotation({
      projectId,
      taskId,
      reviewId: first.review.id,
      revision: 0,
      annotation: { ...annotation, id: "annotation-2", entry: { ...annotation.entry, id: "entry-2" } },
    }, broadcast)).toThrow(CodeReviewMutationConflictError);

    const current = getCodeReview(first.review.id)!;
    current.abandon();
    const terminal = saveCodeReview(current)!;
    expect(() => addCodeReviewAnnotation({
      projectId,
      taskId,
      reviewId: terminal.id,
      revision: terminal.revision,
      annotation: { ...annotation, id: "annotation-3", entry: { ...annotation.entry, id: "entry-3" } },
    }, broadcast)).toThrow(CodeReviewMutationConflictError);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});
