import { randomUUID } from "crypto";
import {
  CodeReviewRevisionConflictError,
  createCodeReview,
  getCodeReview,
  getOpenCodeReview,
  saveCodeReview,
} from "../code-review-store.js";
import { getDb } from "../db.js";
import { getTask } from "../task-store.js";
import type { Broadcast } from "./broadcast.js";
import {
  CodeReviewError,
  type AddCodeReviewAnnotationInput,
  type CodeReview,
  type ExpectedCodeReview,
  type NewReviewComment,
} from "./code-review.js";
import { reviewAnchorFromPatch } from "./review-diff-anchor.js";

export interface CodeReviewScope {
  taskId: number | null;
}

export type AddCodeReviewAnnotationCommand = AddCodeReviewAnnotationInput & {
  scope: CodeReviewScope;
};

export interface AddCodeReviewAnnotationResult {
  review: CodeReview;
  created: boolean;
}

export interface AddCodeReviewCommentCommand {
  scope: CodeReviewScope;
  expectedReview?: ExpectedCodeReview;
  comment: NewReviewComment;
  author: string;
}

export interface DeleteCodeReviewCommentCommand {
  scope: CodeReviewScope;
  expectedReview: ExpectedCodeReview;
  commentId: string;
}

/**
 * Project-scoped code-review operations shared by REST and agent adapters.
 * Owns scope validation, persistence orchestration, concurrency, and
 * post-commit invalidation.
 */
export class ProjectCodeReviews {
  constructor(
    private readonly projectId: number,
    private readonly broadcast: Broadcast,
  ) {}

  getOpen(scope: CodeReviewScope): CodeReview | null {
    this.ensureScope(scope);
    return getOpenCodeReview({ projectId: this.projectId, taskId: scope.taskId });
  }

  /** Resolve a review only within this project's exact task scope. */
  get(scope: CodeReviewScope, reviewId: string): CodeReview {
    this.ensureScope(scope);
    const review = getCodeReview(reviewId);
    if (!review || review.projectId !== this.projectId || review.taskId !== scope.taskId) {
      throw new CodeReviewError("Code review does not belong to the requested scope", "conflict");
    }
    return review;
  }

  /** Resolve an exact scoped review and enforce its optimistic revision. */
  getExpected(scope: CodeReviewScope, expected: ExpectedCodeReview): CodeReview {
    const review = this.get(scope, expected.id);
    this.expectRevision(review, expected.revision);
    return review;
  }

  expectRevision(review: CodeReview, expectedRevision: number): void {
    if (review.revision !== expectedRevision) {
      throw new CodeReviewError(
        `Code review revision conflict: expected ${expectedRevision}, found ${review.revision}`,
        "conflict",
      );
    }
  }

  addAnnotation(command: AddCodeReviewAnnotationCommand): AddCodeReviewAnnotationResult {
    this.ensureScope(command.scope);

    const mutation = getDb().transaction(() => {
      const resolved = this.resolveReview(command);
      const { review } = resolved;

      review.addAnnotation(command.annotation);
      const saved = saveCodeReview(review);
      if (!saved) {
        throw new CodeReviewError(`Code review ${review.id} no longer exists`, "conflict");
      }
      return { review: saved, created: resolved.created };
    });

    try {
      const result = mutation.immediate();
      this.broadcast({
        type: "code_review_updated",
        projectId: result.review.projectId,
        taskId: result.review.taskId,
        reviewId: result.review.id,
        revision: result.review.revision,
      });
      return { review: result.review, created: result.created };
    } catch (error) {
      if (error instanceof CodeReviewRevisionConflictError) {
        throw new CodeReviewError(error.message, "conflict");
      }
      throw error;
    }
  }

  /** Turn a small comment intent into authoritative persisted anchor evidence. */
  addComment(command: AddCodeReviewCommentCommand): AddCodeReviewAnnotationResult {
    const body = command.comment.body.trim();
    if (!body) throw new CodeReviewError("Review comment body cannot be empty", "invalid");

    let anchor;
    try {
      anchor = reviewAnchorFromPatch(command.comment.filePatch, command.comment);
    } catch (error) {
      throw new CodeReviewError(
        error instanceof Error ? error.message : String(error),
        "invalid",
      );
    }

    return this.addAnnotation({
      scope: command.scope,
      expectedReview: command.expectedReview,
      annotation: {
        id: randomUUID(),
        anchor,
        entry: {
          id: randomUUID(),
          author: command.author,
          body,
          createdAt: new Date().toISOString(),
        },
      },
    });
  }

  deleteComment(command: DeleteCodeReviewCommentCommand): CodeReview {
    const mutation = getDb().transaction(() => {
      const review = this.getExpected(command.scope, command.expectedReview);
      review.deleteComment(command.commentId);
      const saved = saveCodeReview(review);
      if (!saved) {
        throw new CodeReviewError(`Code review ${review.id} no longer exists`, "conflict");
      }
      return saved;
    });

    try {
      const review = mutation.immediate();
      this.broadcast({
        type: "code_review_updated",
        projectId: review.projectId,
        taskId: review.taskId,
        reviewId: review.id,
        revision: review.revision,
      });
      return review;
    } catch (error) {
      if (error instanceof CodeReviewRevisionConflictError) {
        throw new CodeReviewError(error.message, "conflict");
      }
      throw error;
    }
  }

  private resolveReview(command: AddCodeReviewAnnotationCommand): AddCodeReviewAnnotationResult {
    if (command.expectedReview) {
      return {
        review: this.getExpected(command.scope, command.expectedReview),
        created: false,
      };
    }

    const existing = getOpenCodeReview({
      projectId: this.projectId,
      taskId: command.scope.taskId,
    });
    if (existing) return { review: existing, created: false };

    return {
      review: createCodeReview({
        id: randomUUID(),
        projectId: this.projectId,
        taskId: command.scope.taskId,
      }),
      created: true,
    };
  }

  private ensureScope(scope: CodeReviewScope): void {
    if (scope.taskId === null) return;
    const task = getTask(scope.taskId);
    if (!task || task.project_id !== this.projectId) {
      throw new CodeReviewError("Code review task scope not found", "not-found");
    }
  }
}
