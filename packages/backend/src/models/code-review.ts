import { Type, type Static } from "@sinclair/typebox";

const NonEmptyStringSchema = Type.String({ minLength: 1, pattern: "\\S" });
const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);

export const CodeReviewStatusSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("submitted"),
  Type.Literal("abandoned"),
]);
export type CodeReviewStatus = Static<typeof CodeReviewStatusSchema>;

export const ReviewSideSchema = Type.Union([Type.Literal("old"), Type.Literal("new")]);
export type ReviewSide = Static<typeof ReviewSideSchema>;

export const ReviewAnchorEvidenceSchema = Type.Object({
  path: NonEmptyStringSchema,
  oldPath: NullableStringSchema,
  side: ReviewSideSchema,
  startLine: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  excerpt: Type.String(),
  contextBefore: NullableStringSchema,
  contextAfter: NullableStringSchema,
  fileFingerprint: NullableStringSchema,
  baseRevision: NullableStringSchema,
  headRevision: NullableStringSchema,
});
export type ReviewAnchorEvidence = Static<typeof ReviewAnchorEvidenceSchema>;

export const ReviewEntrySchema = Type.Object({
  id: NonEmptyStringSchema,
  author: NonEmptyStringSchema,
  body: NonEmptyStringSchema,
  createdAt: NonEmptyStringSchema,
  sourceKey: Type.Optional(NonEmptyStringSchema),
  sourceUrl: Type.Optional(NonEmptyStringSchema),
});
export type ReviewEntry = Static<typeof ReviewEntrySchema>;

export const ReviewAnnotationSchema = Type.Object({
  id: NonEmptyStringSchema,
  anchor: ReviewAnchorEvidenceSchema,
  entries: Type.Array(ReviewEntrySchema),
});
export type ReviewAnnotation = Static<typeof ReviewAnnotationSchema>;

export const NewReviewAnnotationSchema = Type.Object({
  id: NonEmptyStringSchema,
  anchor: ReviewAnchorEvidenceSchema,
  entry: ReviewEntrySchema,
});
export type NewReviewAnnotation = Static<typeof NewReviewAnnotationSchema>;

export const ExpectedCodeReviewSchema = Type.Object({
  id: NonEmptyStringSchema,
  revision: Type.Integer({ minimum: 0 }),
});
export type ExpectedCodeReview = Static<typeof ExpectedCodeReviewSchema>;

export const AddCodeReviewAnnotationInputSchema = Type.Object({
  expectedReview: Type.Optional(ExpectedCodeReviewSchema),
  annotation: NewReviewAnnotationSchema,
});
export type AddCodeReviewAnnotationInput = Static<typeof AddCodeReviewAnnotationInputSchema>;

export const CodeReviewStateSchema = Type.Object({
  id: NonEmptyStringSchema,
  projectId: Type.Integer({ minimum: 1 }),
  taskId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  status: CodeReviewStatusSchema,
  revision: Type.Integer({ minimum: 0 }),
  annotations: Type.Array(ReviewAnnotationSchema),
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
});
export type CodeReviewState = Static<typeof CodeReviewStateSchema>;

export type CodeReviewErrorKind = "invalid" | "not-found" | "conflict";

/** One domain error surface shared by direct, project-scoped, and adapter callers. */
export class CodeReviewError extends Error {
  constructor(
    message: string,
    readonly kind: CodeReviewErrorKind,
  ) {
    super(message);
    this.name = "CodeReviewError";
  }
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
    this.ensureValidAnchor(input.anchor);

    if (this.findIdentityCollision(input.id, input.entry)) {
      throw new CodeReviewError("Review annotation or entry identity is already in use", "conflict");
    }

    this.annotations.push({ id: input.id, anchor: input.anchor, entries: [input.entry] });
  }

  /** Import or refresh an annotation using a review-wide source identity. */
  upsertAnnotation(input: NewReviewAnnotation): void {
    this.ensureOpen("upsert annotations in");
    const sourceKey = input.entry.sourceKey;
    if (sourceKey == null) {
      throw new CodeReviewError("Review annotation upsert requires sourceKey", "invalid");
    }

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
    if (this.findIdentityCollision(null, entry)) {
      throw new CodeReviewError("Review entry identity is already in use", "conflict");
    }
    const annotation = this.annotations.find((candidate) => candidate.id === annotationId);
    if (!annotation) {
      throw new CodeReviewError(`Review annotation not found: ${annotationId}`, "not-found");
    }
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
      throw new CodeReviewError(`Cannot ${action} ${this.status} code review`, "conflict");
    }
  }

  private ensureValidAnchor(anchor: ReviewAnchorEvidence): void {
    if (anchor.startLine < 1 || anchor.endLine < anchor.startLine) {
      throw new CodeReviewError(
        "Review annotation endLine must be greater than or equal to a positive startLine",
        "invalid",
      );
    }
  }

  private findIdentityCollision(
    annotationId: string | null,
    entry: ReviewEntry,
  ): ReviewAnnotation | null {
    return this.annotations.find((annotation) =>
      (annotationId !== null && annotation.id === annotationId)
      || annotation.entries.some((existing) =>
        existing.id === entry.id
        || (entry.sourceKey != null && existing.sourceKey === entry.sourceKey),
      ),
    ) ?? null;
  }

  private findEntryBySourceKey(sourceKey: string): ReviewEntry | null {
    for (const annotation of this.annotations) {
      const entry = annotation.entries.find((candidate) => candidate.sourceKey === sourceKey);
      if (entry) return entry;
    }
    return null;
  }
}
