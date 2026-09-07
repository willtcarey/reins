export type ReviewSide = "old" | "new";

export interface ReviewAnchorEvidence {
  readonly path: string;
  readonly oldPath: string | null;
  readonly side: ReviewSide;
  readonly startLine: number;
  readonly endLine: number;
  readonly excerpt: string;
  readonly contextBefore: string | null;
  readonly contextAfter: string | null;
  readonly fileFingerprint: string | null;
  readonly baseRevision: string | null;
  readonly headRevision: string | null;
}

export interface ReviewEntry {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly sourceKey?: string;
  readonly sourceUrl?: string;
}

export interface ReviewAnnotation {
  readonly id: string;
  readonly anchor: ReviewAnchorEvidence;
  readonly entries: readonly ReviewEntry[];
}

export interface NewReviewAnnotation {
  readonly id: string;
  readonly anchor: ReviewAnchorEvidence;
  readonly entry: ReviewEntry;
}

export interface CodeReviewState {
  readonly id: string;
  readonly projectId: number;
  readonly taskId: number | null;
  readonly revision: number;
  readonly annotations: readonly ReviewAnnotation[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewLineRange {
  readonly side: ReviewSide;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ReviewedFile {
  readonly id: string;
  readonly contentKey: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly lineText: (side: ReviewSide, line: number) => string | null;
}

export interface ReviewPlacement {
  readonly id: string;
  readonly range: ReviewLineRange;
  readonly comments: readonly Pick<ReviewEntry, "id" | "author" | "body">[];
}

export function reviewPlacements(
  review: CodeReviewState | null,
  file: ReviewedFile,
): readonly ReviewPlacement[] {
  const grouped = new Map<string, ReviewPlacement>();
  for (const annotation of review?.annotations ?? []) {
    const anchor = annotation.anchor;
    if (file.path !== anchor.path && file.oldPath !== anchor.path) continue;
    const range = { side: anchor.side, startLine: anchor.startLine, endLine: anchor.endLine };
    if (!rangeExists(file, range)) continue;
    const id = reviewPlacementId(file.id, range);
    const comments = annotation.entries.map(({ id: entryId, author, body }) => ({ id: entryId, author, body }));
    const existing = grouped.get(id);
    grouped.set(id, existing
      ? { ...existing, comments: [...existing.comments, ...comments] }
      : { id, range, comments });
  }
  return [...grouped.values()].toSorted((left, right) => (
    left.range.endLine - right.range.endLine || left.range.side.localeCompare(right.range.side)
  ));
}

export function reviewPlacementId(fileId: string, range: ReviewLineRange): string {
  return `${encodeURIComponent(fileId)}:${range.side}:${range.endLine}`;
}

export function buildReviewAnnotation(
  file: ReviewedFile,
  range: ReviewLineRange,
  input: {
    readonly annotationId: string;
    readonly id: string;
    readonly author: string;
    readonly body: string;
    readonly createdAt: string;
  },
): NewReviewAnnotation {
  if (range.startLine < 1 || range.endLine < range.startLine || !rangeExists(file, range)) {
    throw new Error("The selected range is no longer available.");
  }
  const lines: string[] = [];
  for (let line = range.startLine; line <= range.endLine; line += 1) {
    lines.push(file.lineText(range.side, line)!);
  }
  return {
    id: input.annotationId,
    anchor: {
      path: file.path,
      oldPath: file.oldPath,
      ...range,
      excerpt: lines.join("\n"),
      contextBefore: file.lineText(range.side, range.startLine - 1),
      contextAfter: file.lineText(range.side, range.endLine + 1),
      fileFingerprint: file.contentKey,
      baseRevision: null,
      headRevision: null,
    },
    entry: { id: input.id, author: input.author, body: input.body, createdAt: input.createdAt },
  };
}

function rangeExists(file: ReviewedFile, range: ReviewLineRange): boolean {
  for (let line = range.startLine; line <= range.endLine; line += 1) {
    if (file.lineText(range.side, line) === null) return false;
  }
  return true;
}
