import { createHash } from "node:crypto";
import type { ReviewAnchorEvidence, ReviewDiffLine, ReviewSide } from "./code-review.js";
import { DiffParser, type DiffFile } from "./diff-parser.js";

export interface ReviewDiffSelection {
  readonly path: string;
  readonly side: ReviewSide;
  readonly startLine: number;
  readonly endLine: number;
}

/** Build durable Reins anchor evidence from one selection in a Git-native patch. */
export function reviewAnchorFromPatch(
  patch: string,
  selection: ReviewDiffSelection,
): ReviewAnchorEvidence {
  if (selection.startLine < 1 || selection.endLine < selection.startLine) {
    throw new Error("Review comment line range is invalid");
  }

  const file = findFilePatch(patch, selection.path);
  if (!file) throw new Error(`Changed file not found in current diff: ${selection.path}`);

  const available = diffLines(file.diff, selection.side);
  const lines: ReviewDiffLine[] = [];
  for (let line = selection.startLine; line <= selection.endLine; line += 1) {
    const found = available.find((candidate) => candidate.line === line);
    if (!found) {
      throw new Error(`Line ${line} is not available on the ${selection.side} side of ${selection.path}`);
    }
    lines.push({ kind: found.kind, text: found.text });
  }

  return {
    path: file.diff.path,
    oldPath: oldPath(file.patch, file.diff.path),
    side: selection.side,
    startLine: selection.startLine,
    lines,
    fileFingerprint: `sha256:${createHash("sha256").update(file.patch).digest("hex")}`,
    filePatch: file.patch,
    baseRevision: null,
    headRevision: null,
  };
}

function findFilePatch(
  patch: string,
  path: string,
): { patch: string; diff: DiffFile } | null {
  const starts = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index);
  for (let index = 0; index < starts.length; index += 1) {
    const filePatch = patch.slice(starts[index]!, starts[index + 1] ?? patch.length);
    const diff = DiffParser.parsePatch(filePatch)[0];
    if (diff?.path === path) return { patch: filePatch, diff };
  }
  return null;
}

function diffLines(
  file: DiffFile,
  side: ReviewSide,
): readonly (ReviewDiffLine & { readonly line: number })[] {
  const result: (ReviewDiffLine & { line: number })[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add" && side === "new" && line.newLine != null) {
        result.push({ kind: "addition", text: line.text, line: line.newLine });
      } else if (line.type === "remove" && side === "old" && line.oldLine != null) {
        result.push({ kind: "deletion", text: line.text, line: line.oldLine });
      } else if (line.type === "context") {
        const number = side === "old" ? line.oldLine : line.newLine;
        if (number != null) result.push({ kind: "context", text: line.text, line: number });
      }
    }
  }
  return result;
}

function oldPath(filePatch: string, currentPath: string): string | null {
  const renamed = filePatch.match(/^rename from (.+)$/m)?.[1];
  if (renamed) return renamed;
  const marker = filePatch.match(/^--- (.+)$/m)?.[1];
  if (!marker || marker === "/dev/null") return null;
  const normalized = marker.startsWith("a/") ? marker.slice(2) : marker;
  return normalized === currentPath ? null : normalized;
}
