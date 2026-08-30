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
} from "./code-review.js";

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

/**
 * Project-scoped code-review operations shared by REST and agent adapters.
 * Owns scope validation, persistence orchestration, concurrency, idempotency,
 * and post-commit invalidation.
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

  addAnnotation(command: AddCodeReviewAnnotationCommand): AddCodeReviewAnnotationResult {
    this.ensureScope(command.scope);

    const mutation = getDb().transaction(() => {
      const resolved = this.resolveReview(command);
      const { review } = resolved;
      const annotationResult = review.addAnnotation(command.annotation);
      if (annotationResult === "unchanged") {
        return { review, created: false, changed: false };
      }

      if (command.expectedReview && review.revision !== command.expectedReview.revision) {
        throw new CodeReviewError(
          `Code review revision conflict: expected ${command.expectedReview.revision}, found ${review.revision}`,
          "conflict",
        );
      }

      const saved = saveCodeReview(review);
      if (!saved) {
        throw new CodeReviewError(`Code review ${review.id} no longer exists`, "conflict");
      }
      return { review: saved, created: resolved.created, changed: true };
    });

    try {
      const result = mutation.immediate();
      if (result.changed) {
        this.broadcast({
          type: "code_review_updated",
          projectId: result.review.projectId,
          taskId: result.review.taskId,
          reviewId: result.review.id,
          revision: result.review.revision,
          status: result.review.status,
        });
      }
      return { review: result.review, created: result.created };
    } catch (error) {
      if (error instanceof CodeReviewRevisionConflictError) {
        throw new CodeReviewError(error.message, "conflict");
      }
      throw error;
    }
  }

  private resolveReview(command: AddCodeReviewAnnotationCommand): AddCodeReviewAnnotationResult {
    if (command.expectedReview) {
      const review = getCodeReview(command.expectedReview.id);
      if (!review) {
        throw new CodeReviewError(`Code review ${command.expectedReview.id} not found`, "conflict");
      }
      if (review.projectId !== this.projectId || review.taskId !== command.scope.taskId) {
        throw new CodeReviewError("Code review does not belong to the requested scope", "conflict");
      }
      return { review, created: false };
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
