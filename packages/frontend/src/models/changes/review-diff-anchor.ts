import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewDiffLine, ReviewSide } from "../code-review.js";

export interface PositionedReviewDiffLine extends ReviewDiffLine {
  readonly line: number;
}

/** Translate Pierre metadata into ordered, side-specific review rows. */
export function reviewDiffLines(
  fileDiff: FileDiffMetadata,
  side: ReviewSide,
): readonly PositionedReviewDiffLine[] {
  const result: PositionedReviewDiffLine[] = [];
  for (const hunk of fileDiff.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          result.push({
            kind: "context",
            line: side === "old" ? oldLine : newLine,
            text: lineText(fileDiff.additionLines[content.additionLineIndex + offset]!),
          });
          oldLine += 1;
          newLine += 1;
        }
        continue;
      }

      for (let offset = 0; offset < content.deletions; offset += 1) {
        if (side === "old") {
          result.push({
            kind: "deletion",
            line: oldLine,
            text: lineText(fileDiff.deletionLines[content.deletionLineIndex + offset]!),
          });
        }
        oldLine += 1;
      }
      for (let offset = 0; offset < content.additions; offset += 1) {
        if (side === "new") {
          result.push({
            kind: "addition",
            line: newLine,
            text: lineText(fileDiff.additionLines[content.additionLineIndex + offset]!),
          });
        }
        newLine += 1;
      }
    }
  }
  return result;
}

function lineText(value: string): string {
  return value.replace(/\r?\n$|\r$/, "");
}
