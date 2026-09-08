export type ReviewSide = "old" | "new";
export type ReviewDiffLineKind = "context" | "addition" | "deletion";

export interface ReviewDiffLine {
  readonly kind: ReviewDiffLineKind;
  readonly text: string;
}

export interface ReviewAnchorEvidence {
  readonly path: string;
  readonly oldPath: string | null;
  readonly side: ReviewSide;
  readonly startLine: number;
  /** Original row contents support exact matching and unambiguous relocation. */
  readonly lines: readonly ReviewDiffLine[];
  readonly fileFingerprint: string | null;
  /** Exact Git-native per-file patch shown when this anchor was created. */
  readonly filePatch: string;
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
  readonly filePatch: string;
  readonly diffLines: (side: ReviewSide) => readonly (ReviewDiffLine & { readonly line: number })[];
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
  const lines = new Map<ReviewSide, ReturnType<ReviewedFile["diffLines"]>>();
  for (const annotation of review?.annotations ?? []) {
    const anchor = annotation.anchor;
    if (file.path !== anchor.path && file.oldPath !== anchor.path) continue;
    const current = lines.get(anchor.side) ?? file.diffLines(anchor.side);
    lines.set(anchor.side, current);
    const range = placementRange(anchor, current);
    if (!range) continue;
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
  if (range.startLine < 1 || range.endLine < range.startLine) {
    throw new Error("The selected range is no longer available.");
  }
  const available = file.diffLines(range.side);
  const lines: ReviewDiffLine[] = [];
  for (let line = range.startLine; line <= range.endLine; line += 1) {
    const diffLine = available.find((candidate) => candidate.line === line);
    if (!diffLine) throw new Error("The selected range is no longer available.");
    lines.push({ kind: diffLine.kind, text: diffLine.text });
  }
  return {
    id: input.annotationId,
    anchor: {
      path: file.path,
      oldPath: file.oldPath,
      side: range.side,
      startLine: range.startLine,
      lines,
      fileFingerprint: file.contentKey,
      filePatch: file.filePatch,
      baseRevision: null,
      headRevision: null,
    },
    entry: { id: input.id, author: input.author, body: input.body, createdAt: input.createdAt },
  };
}

function placementRange(
  anchor: ReviewAnchorEvidence,
  current: ReturnType<ReviewedFile["diffLines"]>,
): ReviewLineRange | null {
  const ranges: ReviewLineRange[] = [];
  for (let start = 0; start <= current.length - anchor.lines.length; start += 1) {
    const candidate = current.slice(start, start + anchor.lines.length);
    if (!candidate.every((line, index) => (
      line.kind === anchor.lines[index]!.kind
      && line.text === anchor.lines[index]!.text
      && (index === 0 || line.line === candidate[index - 1]!.line + 1)
    ))) continue;
    ranges.push({
      side: anchor.side,
      startLine: candidate[0]!.line,
      endLine: candidate[candidate.length - 1]!.line,
    });
  }

  const exact = ranges.find(({ startLine }) => startLine === anchor.startLine);
  return exact ?? (ranges.length === 1 ? ranges[0]! : null);
}
