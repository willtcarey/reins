import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import {
  createCodeReview,
  getCodeReview,
  getOpenCodeReview,
  saveCodeReview,
} from "../code-review-store.js";
import { getDb } from "../db.js";
import { getTask } from "../task-store.js";
import type { Broadcast } from "./broadcast.js";
import type { CodeReview, NewReviewAnnotation, ReviewAnnotation } from "./code-review.js";

export interface CodeReviewScope {
  taskId: number | null;
}

export interface ExpectedCodeReview {
  id: string;
  revision: number;
}

export interface AddCodeReviewAnnotationCommand {
  scope: CodeReviewScope;
  annotation: NewReviewAnnotation;
  expectedReview?: ExpectedCodeReview;
}

export interface AddCodeReviewAnnotationResult {
  review: CodeReview;
  created: boolean;
}

export class CodeReviewMutationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeReviewMutationConflictError";
  }
}

export class CodeReviewScopeNotFoundError extends Error {
  constructor(message = "Code review task scope not found") {
    super(message);
    this.name = "CodeReviewScopeNotFoundError";
  }
}

export class InvalidCodeReviewAnnotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCodeReviewAnnotationError";
  }
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
    this.ensureValidAnnotation(command.annotation);

    const mutation = getDb().transaction(() => {
      const resolved = this.resolveReview(command);
      const { review } = resolved;
      if (review.status !== "open") {
        throw new CodeReviewMutationConflictError(`Code review ${review.id} is ${review.status}`);
      }

      const existing = findIdentityCollision(review, command.annotation);
      if (existing) {
        if (sameAnnotation(existing, command.annotation)) {
          return { review, created: false, changed: false };
        }
        throw new CodeReviewMutationConflictError("Review annotation or entry identity is already in use");
      }

      if (command.expectedReview && review.revision !== command.expectedReview.revision) {
        throw new CodeReviewMutationConflictError(
          `Code review revision conflict: expected ${command.expectedReview.revision}, found ${review.revision}`,
        );
      }

      review.addAnnotation(command.annotation);
      const saved = saveCodeReview(review);
      if (!saved) throw new CodeReviewMutationConflictError(`Code review ${review.id} no longer exists`);
      return { review: saved, created: resolved.created, changed: true };
    });

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
  }

  private resolveReview(command: AddCodeReviewAnnotationCommand): AddCodeReviewAnnotationResult {
    if (command.expectedReview) {
      const review = getCodeReview(command.expectedReview.id);
      if (!review) {
        throw new CodeReviewMutationConflictError(`Code review ${command.expectedReview.id} not found`);
      }
      if (review.projectId !== this.projectId || review.taskId !== command.scope.taskId) {
        throw new CodeReviewMutationConflictError("Code review does not belong to the requested scope");
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
    if (!task || task.project_id !== this.projectId) throw new CodeReviewScopeNotFoundError();
  }

  private ensureValidAnnotation(annotation: NewReviewAnnotation): void {
    if (annotation.anchor.startLine < 1 || annotation.anchor.endLine < annotation.anchor.startLine) {
      throw new InvalidCodeReviewAnnotationError(
        "Review annotation endLine must be greater than or equal to a positive startLine",
      );
    }
  }
}

function findIdentityCollision(
  review: CodeReview,
  input: NewReviewAnnotation,
): ReviewAnnotation | null {
  return review.annotations.find((annotation) =>
    annotation.id === input.id
    || annotation.entries.some((entry) => entry.id === input.entry.id),
  ) ?? null;
}

function sameAnnotation(existing: ReviewAnnotation, input: NewReviewAnnotation): boolean {
  const entry = existing.entries.find((candidate) => candidate.id === input.entry.id);
  return existing.id === input.id
    && entry !== undefined
    && isDeepStrictEqual(existing.anchor, input.anchor)
    && isDeepStrictEqual(entry, input.entry);
}
