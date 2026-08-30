export type CodeReviewStatus = "open" | "submitted" | "abandoned";
export type ReviewSide = "old" | "new";

export interface ReviewAnchorEvidence {
  path: string;
  oldPath: string | null;
  side: ReviewSide;
  startLine: number;
  endLine: number;
  excerpt: string;
  contextBefore: string | null;
  contextAfter: string | null;
  fileFingerprint: string | null;
  baseRevision: string | null;
  headRevision: string | null;
}

export interface ReviewEntry {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  sourceKey?: string;
  sourceUrl?: string;
}

export interface ReviewAnnotation {
  id: string;
  anchor: ReviewAnchorEvidence;
  entries: ReviewEntry[];
}

export interface NewReviewAnnotation {
  id: string;
  anchor: ReviewAnchorEvidence;
  entry: ReviewEntry;
}

export interface CodeReviewState {
  id: string;
  projectId: number;
  taskId: number | null;
  status: CodeReviewStatus;
  revision: number;
  annotations: ReviewAnnotation[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A saved code review. Composer state stays in the frontend; this model owns
 * persisted annotations, their thread entries, and import identity.
 */
export class CodeReview {
  readonly id: string;
  readonly projectId: number;
  readonly taskId: number | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  annotations: ReviewAnnotation[];
  private currentStatus: CodeReviewStatus;

  private constructor(state: CodeReviewState) {
    this.id = state.id;
    this.projectId = state.projectId;
    this.taskId = state.taskId;
    this.currentStatus = state.status;
    this.revision = state.revision;
    this.createdAt = state.createdAt;
    this.updatedAt = state.updatedAt;
    this.annotations = state.annotations;
  }

  static restore(state: CodeReviewState): CodeReview {
    return new CodeReview(state);
  }

  get status(): CodeReviewStatus {
    return this.currentStatus;
  }

  /** Return the authoritative transport/persistence shape without exposing internals. */
  toJSON(): CodeReviewState {
    return {
      id: this.id,
      projectId: this.projectId,
      taskId: this.taskId,
      status: this.status,
      revision: this.revision,
      annotations: this.annotations,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  addAnnotation(input: NewReviewAnnotation): void {
    this.ensureOpen("add annotations to");
    this.ensureIdentityAvailable(input.id, input.entry);
    this.annotations.push({ id: input.id, anchor: input.anchor, entries: [input.entry] });
  }

  /** Import or refresh an annotation using a review-wide source identity. */
  upsertAnnotation(input: NewReviewAnnotation): void {
    this.ensureOpen("upsert annotations in");
    const sourceKey = input.entry.sourceKey;
    if (sourceKey == null) throw new Error("Review annotation upsert requires sourceKey");

    const existing = this.findEntryBySourceKey(sourceKey);
    if (!existing) {
      this.addAnnotation(input);
      return;
    }

    existing.author = input.entry.author;
    existing.body = input.entry.body;
    existing.sourceUrl = input.entry.sourceUrl;
  }

  addReply(annotationId: string, entry: ReviewEntry): void {
    this.ensureOpen("add replies to");
    this.ensureIdentityAvailable(null, entry);
    const annotation = this.annotations.find((candidate) => candidate.id === annotationId);
    if (!annotation) throw new Error(`Review annotation not found: ${annotationId}`);
    annotation.entries.push(entry);
  }

  markSubmitted(): void {
    this.transitionTo("submitted");
  }

  abandon(): void {
    this.transitionTo("abandoned");
  }

  private transitionTo(status: Exclude<CodeReviewStatus, "open">): void {
    this.ensureOpen(`mark as ${status}`);
    this.currentStatus = status;
  }

  private ensureOpen(action: string): void {
    if (this.status !== "open") {
      throw new Error(`Cannot ${action} ${this.status} code review`);
    }
  }

  private ensureIdentityAvailable(annotationId: string | null, entry: ReviewEntry): void {
    for (const annotation of this.annotations) {
      if (annotationId !== null && annotation.id === annotationId) {
        throw new Error(`Duplicate review annotation id: ${annotationId}`);
      }
      for (const existing of annotation.entries) {
        if (existing.id === entry.id) throw new Error(`Duplicate review entry id: ${entry.id}`);
        if (entry.sourceKey != null && existing.sourceKey === entry.sourceKey) {
          throw new Error(`Duplicate review source key: ${entry.sourceKey}`);
        }
      }
    }
  }

  private findEntryBySourceKey(sourceKey: string): ReviewEntry | null {
    for (const annotation of this.annotations) {
      const entry = annotation.entries.find((candidate) => candidate.sourceKey === sourceKey);
      if (entry) return entry;
    }
    return null;
  }
}
