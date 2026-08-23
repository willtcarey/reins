type Side = "old" | "new";
type PatchLineKind = "context" | "addition" | "deletion";

interface PatchLine {
  kind: PatchLineKind;
  text: string;
  oldNewline: boolean;
  newNewline: boolean;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

interface TextLine {
  text: string;
  newline: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Reverse-applies one controlled Git unified file patch to the complete
 * resulting file. Context and addition lines are checked against that file so
 * a stale preview cannot silently hydrate the reviewed diff.
 */
export function reversePatch(patch: string, newText: string): string {
  const hunks = parseHunks(patch);
  const newLines = splitText(newText);
  const oldLines: TextLine[] = [];
  let newCursor = 0;

  for (const hunk of hunks) {
    const hunkStart = rangeIndex(hunk.newStart, hunk.newCount);
    if (hunkStart < newCursor || hunkStart > newLines.length) {
      throw new Error("Unified patch hunk range does not match the resulting file");
    }
    oldLines.push(...newLines.slice(newCursor, hunkStart));
    newCursor = hunkStart;

    for (const line of hunk.lines) {
      if (line.kind !== "deletion") {
        const actual = newLines[newCursor];
        if (!actual || actual.text !== line.text || actual.newline !== line.newNewline) {
          throw new Error("Unified patch content does not match the resulting file");
        }
        newCursor += 1;
      }

      if (line.kind !== "addition") {
        oldLines.push({ text: line.text, newline: line.oldNewline });
      }
    }
  }

  oldLines.push(...newLines.slice(newCursor));
  return joinText(oldLines);
}

/**
 * Extracts a complete side from a new/deleted-file patch. Git includes every
 * line for these one-sided files, so no backend read is needed.
 */
export function extractFile(patch: string, side: Side): string {
  const oneSidedPatch = /^(?:new|deleted) file mode /m.test(patch);
  const nullSide = side === "old"
    ? /^--- \/dev\/null$/m.test(patch) || /^new file mode /m.test(patch)
    : /^\+\+\+ \/dev\/null$/m.test(patch) || /^deleted file mode /m.test(patch);
  if (nullSide) return "";

  const hunks = parseHunks(patch, oneSidedPatch);
  const result: TextLine[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const start = side === "old" ? hunk.oldStart : hunk.newStart;
    const count = side === "old" ? hunk.oldCount : hunk.newCount;
    const index = rangeIndex(start, count);
    if (index !== cursor) throw new Error(`Patch does not contain the complete ${side} file`);

    for (const line of hunk.lines) {
      if (side === "old" && line.kind !== "addition") {
        result.push({ text: line.text, newline: line.oldNewline });
      }
      if (side === "new" && line.kind !== "deletion") {
        result.push({ text: line.text, newline: line.newNewline });
      }
    }
    cursor += count;
  }

  return joinText(result);
}

function parseHunks(patch: string, allowEmpty = false): Hunk[] {
  const physicalLines = patch.match(/.*(?:\n|$)/g) ?? [];
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let previous: PatchLine | null = null;

  for (const physicalLine of physicalLines) {
    if (physicalLine === "") continue;
    const line = physicalLine.endsWith("\n") ? physicalLine.slice(0, -1) : physicalLine;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      previous = null;
      continue;
    }
    if (!current) continue;

    if (line === "\\ No newline at end of file") {
      if (!previous) throw new Error("Invalid no-newline marker in unified patch");
      if (previous.kind !== "addition") previous.oldNewline = false;
      if (previous.kind !== "deletion") previous.newNewline = false;
      continue;
    }

    const prefix = line[0];
    const kind = prefix === " " ? "context" : prefix === "+" ? "addition" : prefix === "-" ? "deletion" : null;
    if (!kind) continue;
    previous = { kind, text: line.slice(1), oldNewline: true, newNewline: true };
    current.lines.push(previous);
  }

  if (hunks.length === 0 && !allowEmpty) throw new Error("Unified patch contains no hunks");
  for (const hunk of hunks) {
    const oldCount = hunk.lines.filter((line) => line.kind !== "addition").length;
    const newCount = hunk.lines.filter((line) => line.kind !== "deletion").length;
    if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) {
      throw new Error("Unified patch hunk line counts are invalid");
    }
  }
  return hunks;
}

function rangeIndex(start: number, count: number): number {
  return count === 0 ? start : start - 1;
}

function splitText(text: string): TextLine[] {
  if (text === "") return [];
  const lines: TextLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    lines.push({ text: text.slice(start, index), newline: true });
    start = index + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), newline: false });
  return lines;
}

function joinText(lines: TextLine[]): string {
  return lines.map((line) => line.text + (line.newline ? "\n" : "")).join("");
}
