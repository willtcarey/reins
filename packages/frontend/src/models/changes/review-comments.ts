export type ReviewSide = "old" | "new";

export interface ReviewLineSelection {
  readonly side: ReviewSide;
  readonly startLine: number;
  readonly endLine: number;
  readonly endSide?: ReviewSide;
}

export interface ReviewLineRange {
  readonly side: ReviewSide;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ReviewComment {
  readonly id: string;
  readonly body: string;
  readonly author: "You";
  readonly range: ReviewLineRange;
}

export interface ReviewCommentComposer {
  readonly body: string;
  readonly error: string | null;
  readonly range: ReviewLineRange;
}

export interface ReviewCommentThread {
  readonly id: string;
  readonly side: ReviewSide;
  readonly lineNumber: number;
  readonly range: ReviewLineRange;
  readonly comments: readonly ReviewComment[];
  readonly composer: ReviewCommentComposer | null;
}

export interface ReviewCommentsProjection {
  readonly placements: readonly ReviewCommentThread[];
  readonly selection: ReviewLineRange | null;
  readonly composer: ReviewCommentComposer | null;
  readonly error: string | null;
  readonly threadCount: number;
  readonly draftCount: number;
  readonly layoutRevision: number;
}

export type ReviewCommentCommand =
  | { readonly type: "select"; readonly fileId: string; readonly selection: ReviewLineSelection | null }
  | { readonly type: "open-composer"; readonly fileId: string; readonly selection: ReviewLineSelection }
  | { readonly type: "update-draft"; readonly fileId: string; readonly body: string }
  | { readonly type: "save-comment"; readonly fileId: string }
  | { readonly type: "cancel-composer"; readonly fileId: string }
  | { readonly type: "delete-comment"; readonly fileId: string; readonly commentId: string };

export type ReviewCommentResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface ReviewCommentsChange {
  readonly fileId: string;
  readonly placementId: string | null;
  readonly layoutChanged: boolean;
  readonly selectionChanged: boolean;
}

interface StoredComment extends ReviewComment {
  readonly placementId: string;
}

interface StoredDraft {
  readonly fileId: string;
  readonly placementId: string;
  readonly range: ReviewLineRange;
  body: string;
  error: string | null;
}

interface ActiveSelection {
  readonly fileId: string;
  readonly range: ReviewLineRange;
}

export function normalizeReviewLineRange(
  selection: ReviewLineSelection,
): { readonly ok: true; readonly range: ReviewLineRange } | { readonly ok: false; readonly error: string } {
  const endSide = selection.endSide ?? selection.side;
  if (selection.side !== endSide) {
    return { ok: false, error: "Inline comments must stay on one side of the diff." };
  }
  if (
    !Number.isInteger(selection.startLine)
    || !Number.isInteger(selection.endLine)
    || selection.startLine < 1
    || selection.endLine < 1
  ) {
    return { ok: false, error: "Line numbers must be positive whole numbers." };
  }
  return {
    ok: true,
    range: {
      side: selection.side,
      startLine: Math.min(selection.startLine, selection.endLine),
      endLine: Math.max(selection.startLine, selection.endLine),
    },
  };
}

/**
 * Reins-owned in-memory comment state for one review panel.
 *
 * Pierre coordinates enter only through normalized Reins ranges. Drafts,
 * threads, grouping, selection, and remount restoration all live here rather
 * than in annotation elements.
 */
export class ReviewComments {
  private scopeKey = "";
  private fileContentKeys = new Map<string, string>();
  private comments: StoredComment[] = [];
  private drafts = new Map<string, StoredDraft>();
  private selection: ActiveSelection | null = null;
  private activeDraftKey: string | null = null;
  private errors = new Map<string, string>();
  private layoutRevisions = new Map<string, number>();
  private listeners = new Set<(change: ReviewCommentsChange) => void>();
  private nextCommentId = 1;

  get activeComposerFileId(): string | null {
    return this.activeDraftKey ? this.drafts.get(this.activeDraftKey)?.fileId ?? null : null;
  }

  subscribe(listener: (change: ReviewCommentsChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reconcile(
    scopeKey: string,
    files: readonly { readonly fileId: string; readonly contentKey: string }[],
  ): void {
    if (this.scopeKey && this.scopeKey !== scopeKey) this.clear();
    this.scopeKey = scopeKey;
    const nextFiles = new Map(files.map((file) => [file.fileId, file.contentKey]));
    const invalidFiles = new Set<string>();
    for (const [fileId, contentKey] of this.fileContentKeys) {
      if (nextFiles.get(fileId) !== contentKey) invalidFiles.add(fileId);
    }
    if (invalidFiles.size > 0) {
      const invalidSelectionFileId = this.selection && invalidFiles.has(this.selection.fileId)
        ? this.selection.fileId
        : null;
      this.comments = this.comments.filter((comment) => !invalidFiles.has(fileIdFromPlacement(comment.placementId)));
      for (const [key, draft] of this.drafts) {
        if (invalidFiles.has(draft.fileId)) this.drafts.delete(key);
      }
      if (this.selection && invalidFiles.has(this.selection.fileId)) this.selection = null;
      if (this.activeDraftKey && !this.drafts.has(this.activeDraftKey)) this.activeDraftKey = null;
      for (const fileId of invalidFiles) {
        this.errors.delete(fileId);
        this.bumpLayout(fileId);
        this.notify(fileId, null, true, fileId === invalidSelectionFileId);
      }
    }
    this.fileContentKeys = nextFiles;
  }

  clear(): void {
    const selectionFileId = this.selection?.fileId ?? null;
    const affected = new Set([
      ...this.comments.map((comment) => fileIdFromPlacement(comment.placementId)),
      ...[...this.drafts.values()].map((draft) => draft.fileId),
      ...(selectionFileId ? [selectionFileId] : []),
    ]);
    this.comments = [];
    this.drafts.clear();
    this.selection = null;
    this.activeDraftKey = null;
    this.errors.clear();
    this.fileContentKeys.clear();
    this.layoutRevisions.clear();
    for (const fileId of affected) this.notify(fileId, null, true, fileId === selectionFileId);
  }

  project(fileId: string): ReviewCommentsProjection {
    const grouped = new Map<string, StoredComment[]>();
    for (const comment of this.comments) {
      if (fileIdFromPlacement(comment.placementId) !== fileId) continue;
      const group = grouped.get(comment.placementId) ?? [];
      group.push(comment);
      grouped.set(comment.placementId, group);
    }

    const activeDraft = this.activeDraftKey ? this.drafts.get(this.activeDraftKey) ?? null : null;
    if (activeDraft?.fileId === fileId && !grouped.has(activeDraft.placementId)) {
      grouped.set(activeDraft.placementId, []);
    }
    const placements = [...grouped.entries()].map(([id, storedComments]) => {
      const draft = activeDraft?.fileId === fileId && activeDraft.placementId === id ? activeDraft : null;
      const range = draft?.range ?? storedComments[0]?.range;
      if (!range) throw new Error("Inline comment placement has no range");
      return {
        id,
        side: range.side,
        lineNumber: range.endLine,
        range,
        comments: storedComments.map(({ placementId: _placementId, ...comment }) => comment),
        composer: draft ? composerFromDraft(draft) : null,
      } satisfies ReviewCommentThread;
    }).toSorted((left, right) => left.lineNumber - right.lineNumber || left.side.localeCompare(right.side));

    return {
      placements,
      selection: this.selection?.fileId === fileId ? this.selection.range : null,
      composer: activeDraft?.fileId === fileId ? composerFromDraft(activeDraft) : null,
      error: this.errors.get(fileId) ?? null,
      threadCount: placements.reduce((total, placement) => total + placement.comments.length, 0),
      draftCount: [...this.drafts.values()].filter((draft) => draft.fileId === fileId).length,
      layoutRevision: this.layoutRevisions.get(fileId) ?? 0,
    };
  }

  dispatch(command: ReviewCommentCommand): ReviewCommentResult {
    switch (command.type) {
      case "select":
        return this.select(command.fileId, command.selection);
      case "open-composer":
        return this.openComposer(command.fileId, command.selection);
      case "update-draft":
        return this.updateDraft(command.fileId, command.body);
      case "save-comment":
        return this.saveComment(command.fileId);
      case "cancel-composer":
        return this.cancelComposer(command.fileId);
      case "delete-comment":
        return this.deleteComment(command.fileId, command.commentId);
    }
  }

  private select(fileId: string, selection: ReviewLineSelection | null): ReviewCommentResult {
    if (selection === null) {
      this.selection = null;
      this.errors.delete(fileId);
      this.notify(fileId, null, false, true);
      return { ok: true };
    }
    const normalized = normalizeReviewLineRange(selection);
    if (!normalized.ok) return this.reject(fileId, normalized.error);
    this.selection = { fileId, range: normalized.range };
    this.errors.delete(fileId);
    this.notify(fileId, placementId(fileId, normalized.range), false, true);
    return { ok: true };
  }

  private openComposer(fileId: string, selection: ReviewLineSelection): ReviewCommentResult {
    const normalized = normalizeReviewLineRange(selection);
    if (!normalized.ok) return this.reject(fileId, normalized.error);
    const range = normalized.range;
    const id = placementId(fileId, range);
    const key = draftKey(fileId, range);
    let draft = this.drafts.get(key);
    if (!draft) {
      draft = { fileId, placementId: id, range, body: "", error: null };
      this.drafts.set(key, draft);
    }
    const previousFileId = this.activeComposerFileId;
    this.activeDraftKey = key;
    this.selection = { fileId, range };
    this.errors.delete(fileId);
    if (previousFileId && previousFileId !== fileId) {
      this.bumpLayout(previousFileId);
      this.notify(previousFileId, null, true, false);
    }
    this.bumpLayout(fileId);
    this.notify(fileId, id, true, true);
    return { ok: true };
  }

  private updateDraft(fileId: string, body: string): ReviewCommentResult {
    const draft = this.activeDraft(fileId);
    if (!draft) return this.reject(fileId, "Open a comment composer first.");
    draft.body = body;
    draft.error = null;
    this.notify(fileId, draft.placementId, false);
    return { ok: true };
  }

  private saveComment(fileId: string): ReviewCommentResult {
    const draft = this.activeDraft(fileId);
    if (!draft) return this.reject(fileId, "Open a comment composer first.");
    const body = draft.body.trim();
    if (!body) {
      draft.error = "Enter a comment before saving.";
      this.notify(fileId, draft.placementId, false);
      return { ok: false, error: draft.error };
    }
    this.comments.push({
      id: `inline-comment-${this.nextCommentId++}`,
      placementId: draft.placementId,
      body,
      author: "You",
      range: draft.range,
    });
    this.drafts.delete(this.activeDraftKey!);
    this.activeDraftKey = null;
    this.bumpLayout(fileId);
    this.notify(fileId, draft.placementId, true);
    return { ok: true };
  }

  private cancelComposer(fileId: string): ReviewCommentResult {
    const draft = this.activeDraft(fileId);
    if (!draft) return { ok: true };
    this.drafts.delete(this.activeDraftKey!);
    this.activeDraftKey = null;
    this.errors.delete(fileId);
    this.bumpLayout(fileId);
    this.notify(fileId, draft.placementId, true);
    return { ok: true };
  }

  private deleteComment(fileId: string, commentId: string): ReviewCommentResult {
    const comment = this.comments.find((candidate) => candidate.id === commentId);
    if (!comment || fileIdFromPlacement(comment.placementId) !== fileId) return { ok: true };
    this.comments = this.comments.filter((candidate) => candidate.id !== commentId);
    this.bumpLayout(fileId);
    this.notify(fileId, comment.placementId, true);
    return { ok: true };
  }

  private activeDraft(fileId: string): StoredDraft | null {
    if (!this.activeDraftKey) return null;
    const draft = this.drafts.get(this.activeDraftKey) ?? null;
    return draft?.fileId === fileId ? draft : null;
  }

  private reject(fileId: string, error: string): ReviewCommentResult {
    this.errors.set(fileId, error);
    this.notify(fileId, null, false);
    return { ok: false, error };
  }

  private bumpLayout(fileId: string): void {
    this.layoutRevisions.set(fileId, (this.layoutRevisions.get(fileId) ?? 0) + 1);
  }

  private notify(
    fileId: string,
    placementIdValue: string | null,
    layoutChanged: boolean,
    selectionChanged = false,
  ): void {
    const change = { fileId, placementId: placementIdValue, layoutChanged, selectionChanged };
    for (const listener of this.listeners) listener(change);
  }
}

function composerFromDraft(draft: StoredDraft): ReviewCommentComposer {
  return { body: draft.body, error: draft.error, range: draft.range };
}

function placementId(fileId: string, range: ReviewLineRange): string {
  return `${encodeURIComponent(fileId)}:${range.side}:${range.endLine}`;
}

function fileIdFromPlacement(id: string): string {
  return decodeURIComponent(id.slice(0, id.indexOf(":")));
}

function draftKey(fileId: string, range: ReviewLineRange): string {
  return `${placementId(fileId, range)}:${range.startLine}-${range.endLine}`;
}
