import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  buildReviewAnnotation,
  reviewPlacementId,
  reviewPlacements,
  type CodeReviewState,
  type NewReviewAnnotation,
  type ReviewedFile,
  type ReviewLineRange,
  type ReviewPlacement,
} from "../models/code-review.js";

interface Draft {
  readonly fileId: string;
  readonly placementId: string;
  readonly range: ReviewLineRange;
  body: string;
  error: string | null;
  saving: boolean;
}

export interface InlineReviewPlacement extends ReviewPlacement {
  readonly deletingCommentId: string | null;
  readonly deleteComment: (commentId: string) => Promise<void>;
  readonly composer: null | {
    readonly body: string;
    readonly error: string | null;
    readonly saving: boolean;
    readonly input: (body: string) => void;
    readonly save: () => Promise<void>;
    readonly cancel: () => void;
  };
}

export interface InlineReviewFile {
  readonly placements: readonly InlineReviewPlacement[];
  readonly selection: ReviewLineRange | null;
  readonly error: string | null;
  readonly threadCount: number;
  readonly layoutRevision: number;
  readonly select: (range: ReviewLineRange | null) => void;
  readonly openComposer: (range: ReviewLineRange) => void;
  readonly reportError: (error: string) => void;
}

/** Owns the one panel-wide selection and unsaved inline comment. */
export class InlineReviewController implements ReactiveController {
  onLayoutChange: (() => void) | null = null;

  private review: CodeReviewState | null = null;
  private scopeKey = "";
  private files = new Map<string, ReviewedFile>();
  private draft: Draft | null = null;
  private selection: { fileId: string; range: ReviewLineRange } | null = null;
  private error: { fileId: string; message: string } | null = null;
  private deletingCommentId: string | null = null;
  private layoutRevision = 0;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly saveAnnotation: (annotation: NewReviewAnnotation) => Promise<CodeReviewState>,
    private readonly removeComment: (commentId: string) => Promise<void>,
  ) {
    host.addController(this);
  }

  hostConnected() {}
  hostDisconnected() {}

  get activeComposerFileId(): string | null { return this.draft?.fileId ?? null; }

  setReview(review: CodeReviewState | null): void {
    if (this.review === review) return;
    this.review = review;
    this.update(true);
  }

  reconcile(scopeKey: string, files: readonly ReviewedFile[]): void {
    if (this.scopeKey && this.scopeKey !== scopeKey) this.clear();
    this.scopeKey = scopeKey;
    const next = new Map(files.map((file) => [file.id, file]));
    const changed = (id: string) => this.files.get(id)?.contentKey !== next.get(id)?.contentKey;
    const discardedDraft = this.draft && changed(this.draft.fileId);
    const discardedSelection = this.selection && changed(this.selection.fileId);
    if (discardedDraft) this.draft = null;
    if (discardedSelection) this.selection = null;
    if (this.error && changed(this.error.fileId)) this.error = null;
    this.files = next;
    if (discardedDraft) this.update(true);
    else if (discardedSelection) this.update(false);
  }

  clear(): void {
    const hadDraft = this.draft !== null;
    this.draft = null;
    this.selection = null;
    this.error = null;
    this.deletingCommentId = null;
    this.files.clear();
    if (hadDraft) this.update(true);
  }

  file(fileId: string): InlineReviewFile {
    const file = this.files.get(fileId);
    const placements = [...(this.review && file ? reviewPlacements(this.review, file) : [])];
    if (this.draft?.fileId === fileId && !placements.some(({ id }) => id === this.draft?.placementId)) {
      placements.push({ id: this.draft.placementId, range: this.draft.range, comments: [] });
    }
    const projected = placements.map((placement): InlineReviewPlacement => ({
      ...placement,
      deletingCommentId: this.deletingCommentId,
      deleteComment: (commentId) => this.deleteComment(fileId, commentId),
      composer: this.draft?.fileId === fileId && this.draft.placementId === placement.id
        ? {
            body: this.draft.body,
            error: this.draft.error,
            saving: this.draft.saving,
            input: (body) => this.updateDraft(body),
            save: () => this.saveComment(),
            cancel: () => this.cancelComposer(),
          }
        : null,
    })).toSorted((left, right) => (
      left.range.endLine - right.range.endLine || left.range.side.localeCompare(right.range.side)
    ));
    return {
      placements: projected,
      selection: this.selection?.fileId === fileId ? this.selection.range : null,
      error: this.error?.fileId === fileId ? this.error.message : null,
      threadCount: projected.reduce((count, placement) => count + placement.comments.length, 0),
      layoutRevision: this.layoutRevision,
      select: (range) => this.select(fileId, range),
      openComposer: (range) => this.openComposer(fileId, range),
      reportError: (error) => this.reject(fileId, error),
    };
  }

  private select(fileId: string, range: ReviewLineRange | null): void {
    this.selection = range ? { fileId, range } : null;
    this.error = null;
    this.update(false);
  }

  private openComposer(fileId: string, range: ReviewLineRange): void {
    const id = reviewPlacementId(fileId, range);
    this.draft = this.draft?.fileId === fileId && sameRange(this.draft.range, range)
      ? this.draft
      : { fileId, placementId: id, range, body: "", error: null, saving: false };
    this.selection = { fileId, range };
    this.error = null;
    this.update(true);
  }

  /** Typing stays local so Pierre does not replace the focused annotation element. */
  private updateDraft(body: string): void {
    if (!this.draft) return;
    this.draft.body = body;
    this.draft.error = null;
  }

  private async saveComment(): Promise<void> {
    const draft = this.draft;
    if (!draft || draft.saving) return;
    const body = draft.body.trim();
    if (!body) return this.reject(draft.fileId, "Enter a comment before saving.");
    const file = this.files.get(draft.fileId);
    if (!file?.path) return this.reject(draft.fileId, "This file cannot be anchored for review.");
    let annotation: NewReviewAnnotation;
    try {
      annotation = buildReviewAnnotation(file, draft.range, {
        annotationId: newIdentity(), id: newIdentity(), author: "You", body, createdAt: new Date().toISOString(),
      });
    } catch (error) {
      return this.reject(draft.fileId, message(error));
    }
    draft.saving = true;
    this.update(false);
    try {
      const review = await this.saveAnnotation(annotation);
      if (this.draft !== draft) return;
      this.review = review;
      this.draft = null;
      this.update(true);
    } catch (error) {
      if (this.draft !== draft) return;
      draft.saving = false;
      draft.error = message(error);
      this.update(true);
    }
  }

  private async deleteComment(fileId: string, commentId: string): Promise<void> {
    if (this.deletingCommentId !== null) return;
    this.deletingCommentId = commentId;
    this.error = null;
    this.update(false);
    try {
      await this.removeComment(commentId);
      this.deletingCommentId = null;
      this.update(true);
    } catch (error) {
      this.deletingCommentId = null;
      this.reject(fileId, message(error));
    }
  }

  private cancelComposer(): void {
    if (!this.draft) return;
    this.draft = null;
    this.error = null;
    this.update(true);
  }

  private reject(fileId: string, error: string): void {
    this.error = { fileId, message: error };
    if (this.draft?.fileId === fileId) this.draft.error = error;
    this.update(true);
  }

  private update(layoutChanged: boolean): void {
    if (layoutChanged) {
      this.layoutRevision += 1;
      this.onLayoutChange?.();
    }
    this.host.requestUpdate();
  }
}

function sameRange(left: ReviewLineRange, right: ReviewLineRange): boolean {
  return left.side === right.side && left.startLine === right.startLine && left.endLine === right.endLine;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function newIdentity(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
