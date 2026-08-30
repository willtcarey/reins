import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import { getDb } from "./db.js";
import {
  createCodeReview,
  getCodeReview,
  getOpenCodeReview,
  saveCodeReview,
} from "./code-review-store.js";
import type { Broadcast } from "./models/broadcast.js";
import type { CodeReview, NewReviewAnnotation, ReviewAnnotation } from "./models/code-review.js";

export interface AddCodeReviewAnnotationInput {
  projectId: number;
  taskId: number | null;
  annotation: NewReviewAnnotation;
  reviewId?: string;
  revision?: number;
}

export class CodeReviewMutationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeReviewMutationConflictError";
  }
}

export interface AddCodeReviewAnnotationResult {
  review: CodeReview;
  created: boolean;
}

/**
 * Find or create the scoped open review and persist one domain mutation in a
 * single transaction. The caller can derive creation status from the committed
 * result; invalidation is broadcast only after the transaction commits.
 */
export function addCodeReviewAnnotation(
  input: AddCodeReviewAnnotationInput,
  broadcast: Broadcast,
): AddCodeReviewAnnotationResult {
  const mutation = getDb().transaction(() => {
    const resolved = resolveReview(input);
    const { review } = resolved;
    if (review.status !== "open") {
      throw new CodeReviewMutationConflictError(`Code review ${review.id} is ${review.status}`);
    }

    const existing = findIdentityCollision(review, input.annotation);
    if (existing) {
      if (sameAnnotation(existing, input.annotation)) {
        return { review, created: false, changed: false };
      }
      throw new CodeReviewMutationConflictError("Review annotation or entry identity is already in use");
    }

    if (input.reviewId !== undefined && review.revision !== input.revision) {
      throw new CodeReviewMutationConflictError(
        `Code review revision conflict: expected ${input.revision}, found ${review.revision}`,
      );
    }

    review.addAnnotation(input.annotation);
    const saved = saveCodeReview(review);
    if (!saved) throw new CodeReviewMutationConflictError(`Code review ${review.id} no longer exists`);
    return { review: saved, created: resolved.created, changed: true };
  });

  const result = mutation.immediate();
  if (result.changed) {
    broadcast({
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

function resolveReview(input: AddCodeReviewAnnotationInput): AddCodeReviewAnnotationResult {
  const hasReviewId = input.reviewId !== undefined;
  const hasRevision = input.revision !== undefined;
  if (hasReviewId !== hasRevision) {
    throw new CodeReviewMutationConflictError("reviewId and revision must be supplied together");
  }

  if (input.reviewId !== undefined) {
    const review = getCodeReview(input.reviewId);
    if (!review) throw new CodeReviewMutationConflictError(`Code review ${input.reviewId} not found`);
    if (review.projectId !== input.projectId || review.taskId !== input.taskId) {
      throw new CodeReviewMutationConflictError("Code review does not belong to the requested scope");
    }
    return { review, created: false };
  }

  const existing = getOpenCodeReview(input);
  if (existing) return { review: existing, created: false };

  return {
    review: createCodeReview({
      id: randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId,
    }),
    created: true,
  };
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
