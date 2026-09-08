import { Type, type Static } from "@sinclair/typebox";

const NonEmptyStringSchema = Type.String({ minLength: 1, pattern: "\\S" });
const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);

export const ReviewSideSchema = Type.Union([Type.Literal("old"), Type.Literal("new")]);
export type ReviewSide = Static<typeof ReviewSideSchema>;

export const ReviewDiffLineKindSchema = Type.Union([
  Type.Literal("context"),
  Type.Literal("addition"),
  Type.Literal("deletion"),
]);
export type ReviewDiffLineKind = Static<typeof ReviewDiffLineKindSchema>;

export const ReviewDiffLineSchema = Type.Object({
  kind: ReviewDiffLineKindSchema,
  text: Type.String({ pattern: "^[^\\r\\n]*$" }),
});
export type ReviewDiffLine = Static<typeof ReviewDiffLineSchema>;

export const ReviewAnchorEvidenceSchema = Type.Object({
  path: NonEmptyStringSchema,
  oldPath: NullableStringSchema,
  side: ReviewSideSchema,
  startLine: Type.Integer({ minimum: 1 }),
  lines: Type.Array(ReviewDiffLineSchema, { minItems: 1 }),
  fileFingerprint: NullableStringSchema,
  /** Exact Git-native per-file patch shown when the annotation was created. */
  filePatch: NonEmptyStringSchema,
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

export interface AddCodeReviewAnnotationInput {
  expectedReview?: ExpectedCodeReview;
  annotation: NewReviewAnnotation;
}

export const NewReviewCommentSchema = Type.Object({
  path: NonEmptyStringSchema,
  side: ReviewSideSchema,
  startLine: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  filePatch: NonEmptyStringSchema,
  body: NonEmptyStringSchema,
});
export type NewReviewComment = Static<typeof NewReviewCommentSchema>;

export const CreateCodeReviewCommentInputSchema = Type.Object({
  expectedReview: Type.Optional(ExpectedCodeReviewSchema),
  comment: NewReviewCommentSchema,
});
export type CreateCodeReviewCommentInput = Static<typeof CreateCodeReviewCommentInputSchema>;

export const DeleteCodeReviewCommentInputSchema = Type.Object({
  expectedReview: ExpectedCodeReviewSchema,
});
export type DeleteCodeReviewCommentInput = Static<typeof DeleteCodeReviewCommentInputSchema>;

export const CodeReviewStateSchema = Type.Object({
  id: NonEmptyStringSchema,
  projectId: Type.Integer({ minimum: 1 }),
  taskId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
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

  private constructor(state: CodeReviewState) {
    this.id = state.id;
    this.projectId = state.projectId;
    this.taskId = state.taskId;
    this.revision = state.revision;
    this.createdAt = state.createdAt;
    this.updatedAt = state.updatedAt;
    this.annotations = state.annotations;
  }

  static restore(state: CodeReviewState): CodeReview {
    return new CodeReview(state);
  }

  /** Return the authoritative transport/persistence shape without exposing internals. */
  toJSON(): CodeReviewState {
    return {
      id: this.id,
      projectId: this.projectId,
      taskId: this.taskId,
      revision: this.revision,
      annotations: this.annotations,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  addAnnotation(input: NewReviewAnnotation): void {
    this.ensureValidAnchor(input.anchor);

    if (this.findIdentityCollision(input.id, input.entry)) {
      throw new CodeReviewError("Review annotation or entry identity is already in use", "conflict");
    }

    this.annotations.push({ id: input.id, anchor: input.anchor, entries: [input.entry] });
  }

  /** Import or refresh an annotation using a review-wide source identity. */
  upsertAnnotation(input: NewReviewAnnotation): void {
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
    if (this.findIdentityCollision(null, entry)) {
      throw new CodeReviewError("Review entry identity is already in use", "conflict");
    }
    const annotation = this.annotations.find((candidate) => candidate.id === annotationId);
    if (!annotation) {
      throw new CodeReviewError(`Review annotation not found: ${annotationId}`, "not-found");
    }
    annotation.entries.push(entry);
  }

  deleteComment(entryId: string): void {
    const annotationIndex = this.annotations.findIndex((annotation) =>
      annotation.entries.some((entry) => entry.id === entryId),
    );
    if (annotationIndex === -1) {
      throw new CodeReviewError(`Review comment not found: ${entryId}`, "not-found");
    }

    const annotation = this.annotations[annotationIndex]!;
    annotation.entries = annotation.entries.filter((entry) => entry.id !== entryId);
    if (annotation.entries.length === 0) this.annotations.splice(annotationIndex, 1);
  }

  private ensureValidAnchor(anchor: ReviewAnchorEvidence): void {
    if (anchor.startLine < 1 || anchor.lines.length === 0) {
      throw new CodeReviewError("Review annotation diff selection is invalid", "invalid");
    }
    if (anchor.lines.some(({ text }) => text.includes("\n") || text.includes("\r"))) {
      throw new CodeReviewError("Review annotation diff line text is invalid", "invalid");
    }
    if (!anchor.filePatch.startsWith("diff --git ")) {
      throw new CodeReviewError("Review annotation file patch is invalid", "invalid");
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
