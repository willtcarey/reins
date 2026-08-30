import { describe, expect, mock, test } from "bun:test";
import { createCodeReview, getCodeReview, saveCodeReview } from "../../code-review-store.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";
import {
  CodeReviewMutationConflictError,
  CodeReviewScopeNotFoundError,
  ProjectCodeReviews,
} from "../../models/code-reviews.js";
import { createProject } from "../../project-store.js";
import { createTask } from "../../task-store.js";
import { useTestDb } from "../helpers/test-db.js";

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

describe("ProjectCodeReviews", () => {
  useTestDb();

  test("finds or creates the scoped review, saves its annotation, then broadcasts invalidation", () => {
    const projectId = createProject("Review Project", "/tmp/review-project").id;
    const taskId = createTask(projectId, "Review task", null, "task/review").id;
    const messages: ServerMessage[] = [];
    const broadcast: Broadcast = mock((message) => {
      const persisted = getCodeReview(message.type === "code_review_updated" ? message.reviewId : "");
      expect(persisted?.revision).toBe(1);
      messages.push(message);
    });
    const reviews = new ProjectCodeReviews(projectId, broadcast);

    const result = reviews.addAnnotation({ scope: { taskId }, annotation });

    expect(result.created).toBe(true);
    expect(result.review).toMatchObject({ projectId, taskId, status: "open", revision: 1 });
    expect(reviews.getOpen({ taskId })?.id).toBe(result.review.id);
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

  test("does not require review identity but uses a known review as a concurrency guard", () => {
    const projectId = createProject("Review Project", "/tmp/review-project").id;
    const taskId = createTask(projectId, "Review task", null, "task/review").id;
    const broadcast = mock<Broadcast>(() => {});
    const reviews = new ProjectCodeReviews(projectId, broadcast);
    const open = createCodeReview({ id: "review-existing", projectId, taskId });
    const first = reviews.addAnnotation({
      scope: { taskId },
      expectedReview: { id: open.id, revision: open.revision },
      annotation,
    });

    reviews.addAnnotation({
      scope: { taskId },
      expectedReview: { id: first.review.id, revision: first.review.revision },
      annotation: {
        ...annotation,
        id: "annotation-client-2",
        entry: { ...annotation.entry, id: "entry-client-2", body: "A later comment" },
      },
    });

    const retried = reviews.addAnnotation({
      scope: { taskId },
      expectedReview: { id: open.id, revision: open.revision },
      annotation,
    });

    expect(retried).toMatchObject({ created: false });
    expect(retried.review).toMatchObject({ id: first.review.id, revision: 2 });
    expect(retried.review.annotations).toHaveLength(2);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  test("conflicts instead of switching a stale or terminal known review", () => {
    const projectId = createProject("Review Project", "/tmp/review-project").id;
    const taskId = createTask(projectId, "Review task", null, "task/review").id;
    const broadcast = mock<Broadcast>(() => {});
    const reviews = new ProjectCodeReviews(projectId, broadcast);
    const first = reviews.addAnnotation({ scope: { taskId }, annotation });

    expect(() => reviews.addAnnotation({
      scope: { taskId },
      expectedReview: { id: first.review.id, revision: 0 },
      annotation: { ...annotation, id: "annotation-2", entry: { ...annotation.entry, id: "entry-2" } },
    })).toThrow(CodeReviewMutationConflictError);

    const current = getCodeReview(first.review.id)!;
    current.abandon();
    const terminal = saveCodeReview(current)!;
    expect(() => reviews.addAnnotation({
      scope: { taskId },
      expectedReview: { id: terminal.id, revision: terminal.revision },
      annotation: { ...annotation, id: "annotation-3", entry: { ...annotation.entry, id: "entry-3" } },
    })).toThrow(CodeReviewMutationConflictError);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  test("validates task ownership and annotation range for every caller", () => {
    const projectId = createProject("Review Project", "/tmp/review-project").id;
    const otherProjectId = createProject("Other Project", "/tmp/other-review-project").id;
    const otherTaskId = createTask(otherProjectId, "Other task", null, "task/other").id;
    const reviews = new ProjectCodeReviews(projectId, mock<Broadcast>(() => {}));

    expect(() => reviews.getOpen({ taskId: otherTaskId })).toThrow(CodeReviewScopeNotFoundError);
    expect(() => reviews.addAnnotation({
      scope: { taskId: null },
      annotation: {
        ...annotation,
        anchor: { ...annotation.anchor, startLine: 5, endLine: 4 },
      },
    })).toThrow("endLine");
  });
});
