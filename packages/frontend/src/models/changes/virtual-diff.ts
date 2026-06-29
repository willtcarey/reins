import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

export interface VirtualDiffItem {
  id: string;
  type: "diff";
  path: string;
  fileDiff: FileDiffMetadata;
  version: number;
  collapsed?: boolean;
}

export interface VirtualDiffParseResult {
  items: VirtualDiffItem[];
  pathToItemId: Map<string, string>;
}

export interface VirtualDiffData extends VirtualDiffParseResult {
  branch: string | null;
  baseBranch: string | null;
}

export type VirtualDiffRowType = "collapsed" | "hunk" | "context" | "addition" | "deletion";

export interface VirtualDiffRow {
  type: VirtualDiffRowType;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export function parseVirtualDiffPatch(
  patch: string,
  options: { cacheKeyPrefix: string },
): VirtualDiffParseResult {
  const parsedPatches = parsePatchFiles(patch, options.cacheKeyPrefix, true);
  const items: VirtualDiffItem[] = [];
  const pathToItemId = new Map<string, string>();
  const pathOccurrences = new Map<string, number>();

  for (const parsedPatch of parsedPatches) {
    for (const fileDiff of parsedPatch.files) {
      const path = fileDiff.name;
      const occurrence = pathOccurrences.get(path) ?? 0;
      pathOccurrences.set(path, occurrence + 1);
      const id = virtualDiffItemId(path, occurrence);
      items.push({
        id,
        type: "diff",
        path,
        fileDiff,
        version: 1,
      });
      if (!pathToItemId.has(path)) pathToItemId.set(path, id);
    }
  }

  return { items, pathToItemId };
}

export function virtualDiffItemId(path: string, occurrence: number): string {
  return `diff:${encodeURIComponent(path)}:${occurrence}`;
}

export function buildVirtualDiffRows(fileDiff: FileDiffMetadata): VirtualDiffRow[] {
  const rows: VirtualDiffRow[] = [];

  for (const hunk of fileDiff.hunks) {
    if (hunk.collapsedBefore > 0) {
      rows.push({
        type: "collapsed",
        text: `${hunk.collapsedBefore} unchanged line${hunk.collapsedBefore === 1 ? "" : "s"}`,
      });
    }

    rows.push({
      type: "hunk",
      text: (hunk.hunkSpecs ?? `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`).trimEnd(),
    });

    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let i = 0; i < content.lines; i += 1) {
          rows.push({
            type: "context",
            text: fileDiff.additionLines[content.additionLineIndex + i] ?? "",
            oldLine,
            newLine,
          });
          oldLine += 1;
          newLine += 1;
        }
        continue;
      }

      for (let i = 0; i < content.deletions; i += 1) {
        rows.push({
          type: "deletion",
          text: fileDiff.deletionLines[content.deletionLineIndex + i] ?? "",
          oldLine,
        });
        oldLine += 1;
      }

      for (let i = 0; i < content.additions; i += 1) {
        rows.push({
          type: "addition",
          text: fileDiff.additionLines[content.additionLineIndex + i] ?? "",
          newLine,
        });
        newLine += 1;
      }
    }
  }

  return rows;
}
