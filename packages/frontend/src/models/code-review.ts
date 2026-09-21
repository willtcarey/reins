import type {
  CodeReviewState,
  ReviewAnchorEvidence,
  ReviewDiffLine,
  ReviewEntry,
  ReviewSide,
} from "@backend/models/code-review.js";

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
  readonly comments: readonly Pick<ReviewEntry, "id" | "author" | "body" | "createdAt">[];
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
    const comments = annotation.entries.map(({ id: entryId, author, body, createdAt }) => ({ id: entryId, author, body, createdAt }));
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
