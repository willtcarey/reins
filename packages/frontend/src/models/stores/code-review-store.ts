import type { CodeReviewState, NewReviewComment } from "../code-review.js";

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
      const response = await fetch(reviewUrl(scope));
      if (!response.ok) throw new Error(await responseError(response, "Unable to load code review"));
      const review: CodeReviewState | null = await response.json();
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
      const response = await fetch(reviewCommentsUrl(scope), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedReview, comment }),
      });
      if (!response.ok) {
        const message = await responseError(response, "Unable to save code review comment");
        if (response.status === 409) await this.refresh();
        throw new Error(message);
      }
      const review: CodeReviewState = await response.json();
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
      const response = await fetch(reviewCommentUrl(scope, commentId), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedReview: { id: review.id, revision: review.revision },
        }),
      });
      if (!response.ok) {
        const message = await responseError(response, "Unable to delete code review comment");
        if (response.status === 409) await this.refresh();
        throw new Error(message);
      }
      const updated: CodeReviewState = await response.json();
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
      const response = await fetch(reviewSubmissionsUrl(scope), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewId: review.id,
          expectedRevision: review.revision,
          sessionId,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to submit code review"));
      const result: { readonly messageId: string } = await response.json();
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

function reviewUrl(scope: CodeReviewScope): string {
  return scopedReviewUrl(scope, "/code-review");
}

function reviewSubmissionsUrl(scope: CodeReviewScope): string {
  return scopedReviewUrl(scope, "/code-review/submissions");
}

function reviewCommentsUrl(scope: CodeReviewScope): string {
  return scopedReviewUrl(scope, "/code-review/comments");
}

function reviewCommentUrl(scope: CodeReviewScope, commentId: string): string {
  return scopedReviewUrl(scope, `/code-review/comments/${encodeURIComponent(commentId)}`);
}

function scopedReviewUrl(scope: CodeReviewScope, path: string): string {
  const task = scope.taskId === null ? "" : `?taskId=${scope.taskId}`;
  return `/api/projects/${scope.projectId}${path}${task}`;
}

function sameScope(left: CodeReviewScope | null, right: CodeReviewScope | null): boolean {
  return left?.projectId === right?.projectId && left?.taskId === right?.taskId;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body: { error?: unknown } | null = await response.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
