import type { CodeReviewState, NewReviewComment } from "@backend/models/code-review.js";
import { ReinsHttpError } from "@reins/client";
import { api } from "../api.js";

interface CodeReviewScope {
  readonly projectId: number;
  readonly taskId: number | null;
}

export class CodeReviewStore {
  scope: CodeReviewScope | null = null;
  review: CodeReviewState | null = null;
  loading = false;
  error: string | null = null;
  submitting = false;
  submissionError: string | null = null;

  private listeners = new Set<() => void>();
  private generation = 0;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setScope(scope: CodeReviewScope | null): Promise<void> {
    if (sameScope(this.scope, scope)) return;
    this.generation += 1;
    this.scope = scope;
    this.review = null;
    this.error = null;
    this.submissionError = null;
    this.submitting = false;
    this.loading = scope !== null;
    this.notify();
    if (scope) await this.refresh();
  }

  async refresh(): Promise<void> {
    const scope = this.scope;
    if (!scope) return;
    const generation = this.generation;
    this.loading = true;
    this.error = null;
    this.notify();

    try {
      const review = await api.reviews.get(scope.projectId, scope.taskId);
      if (generation !== this.generation || !sameScope(this.scope, scope)) return;
      this.review = review;
    } catch (error) {
      if (generation !== this.generation || !sameScope(this.scope, scope)) return;
      this.error = errorMessage(error);
    } finally {
      if (generation === this.generation && sameScope(this.scope, scope)) {
        this.loading = false;
        this.notify();
      }
    }
  }

  async addComment(comment: NewReviewComment): Promise<CodeReviewState> {
    const scope = this.scope;
    if (!scope) throw new Error("No active code review scope");
    const expectedReview = this.review
      ? { id: this.review.id, revision: this.review.revision }
      : undefined;

    try {
      const review = await api.reviews.addComment(scope.projectId, scope.taskId, { expectedReview, comment });
      if (sameScope(this.scope, scope)) {
        const current = this.review;
        if (!current || current.id !== review.id || review.revision >= current.revision) {
          this.review = review;
        }
        this.error = null;
        this.notify();
      }
      return review;
    } catch (error) {
      if (error instanceof ReinsHttpError && error.status === 409) await this.refresh();
      if (sameScope(this.scope, scope)) {
        this.error = errorMessage(error);
        this.notify();
      }
      throw error;
    }
  }

  async deleteComment(commentId: string): Promise<CodeReviewState> {
    const scope = this.scope;
    const review = this.review;
    if (!scope || !review) throw new Error("No open code review comment to delete");

    try {
      const updated = await api.reviews.deleteComment(
        scope.projectId,
        scope.taskId,
        commentId,
        { expectedReview: { id: review.id, revision: review.revision } },
      );
      if (sameScope(this.scope, scope)) {
        const current = this.review;
        if (!current || current.id !== updated.id || updated.revision >= current.revision) {
          this.review = updated;
        }
        this.error = null;
        this.notify();
      }
      return updated;
    } catch (error) {
      if (error instanceof ReinsHttpError && error.status === 409) await this.refresh();
      if (sameScope(this.scope, scope)) {
        this.error = errorMessage(error);
        this.notify();
      }
      throw error;
    }
  }

  async submit(sessionId: string): Promise<{ readonly messageId: string }> {
    const scope = this.scope;
    const review = this.review;
    if (!scope || !review) throw new Error("No open code review to submit");
    if (review.annotations.length === 0) throw new Error("Code review has no saved comments");
    if (this.submitting) throw new Error("Code review submission is already in progress");

    this.submitting = true;
    this.submissionError = null;
    this.notify();
    try {
      const result = await api.reviews.submit(scope.projectId, scope.taskId, {
        reviewId: review.id,
        expectedRevision: review.revision,
        sessionId,
      });
      if (sameScope(this.scope, scope)) {
        this.review = null;
        this.error = null;
      }
      return result;
    } catch (error) {
      if (sameScope(this.scope, scope)) this.submissionError = errorMessage(error);
      throw error;
    } finally {
      if (sameScope(this.scope, scope)) {
        this.submitting = false;
        this.notify();
      }
    }
  }

  async handleUpdated(update: {
    readonly projectId: number;
    readonly taskId: number | null;
    readonly reviewId: string;
    readonly revision: number;
  }): Promise<void> {
    if (!this.scope || update.projectId !== this.scope.projectId || update.taskId !== this.scope.taskId) return;
    if (this.review && update.reviewId === this.review.id && update.revision <= this.review.revision) return;
    await this.refresh();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function sameScope(left: CodeReviewScope | null, right: CodeReviewScope | null): boolean {
  return left?.projectId === right?.projectId && left?.taskId === right?.taskId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
