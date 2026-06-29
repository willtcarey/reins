export interface DiffLine {
  type: "context" | "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  additions: number;
  removals: number;
  hunks: DiffHunk[];
}

export interface ParsedHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: { prefix: "+" | "-" | " "; text: string }[];
}

export interface ParsedFile {
  path: string;
  hunks: ParsedHunk[];
}

export interface DiffFileSummary {
  path: string;
  additions: number;
  removals: number;
}

export function parsePatch(raw: string): DiffFile[] {
  const parsed = parseUnifiedDiff(raw);
  if (parsed.length === 0) return [];

  return parsed.map((file) => {
    let additions = 0;
    let removals = 0;

    const hunks: DiffHunk[] = file.hunks.map((hunk) => {
      let oldLineNo = hunk.oldStart;
      let newLineNo = hunk.newStart;

      const lines: DiffLine[] = hunk.lines.map((line) => {
        switch (line.prefix) {
          case "+": {
            additions++;
            const result: DiffLine = { type: "add", text: line.text, newLine: newLineNo };
            newLineNo++;
            return result;
          }
          case "-": {
            removals++;
            const result: DiffLine = { type: "remove", text: line.text, oldLine: oldLineNo };
            oldLineNo++;
            return result;
          }
          default: {
            const result: DiffLine = { type: "context", text: line.text, oldLine: oldLineNo, newLine: newLineNo };
            oldLineNo++;
            newLineNo++;
            return result;
          }
        }
      });

      return { header: hunk.header, lines };
    });

    return { path: file.path, additions, removals, hunks };
  });
}

export function parseUnifiedDiff(raw: string): ParsedFile[] {
  if (!raw?.trim()) return [];

  const files: ParsedFile[] = [];
  const lines = raw.split("\n");
  let currentFile: ParsedFile | null = null;
  let currentHunk: ParsedHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.*?) b\/(.*)/);
      currentFile = { path: match ? match[2] : line, hunks: [] };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (
      line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++") ||
      line.startsWith("new file mode") || line.startsWith("deleted file mode") ||
      line.startsWith("old mode") || line.startsWith("new mode") ||
      line.startsWith("rename from") || line.startsWith("rename to") ||
      line.startsWith("similarity index") || line.startsWith("Binary files")
    ) continue;

    if (line.startsWith("@@")) {
      if (!currentFile) continue;
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      currentHunk = {
        header: line,
        oldStart: match ? parseInt(match[1], 10) : 0,
        newStart: match ? parseInt(match[2], 10) : 0,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.lines.push({ prefix: "+", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ prefix: "-", text: line.slice(1) });
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({ prefix: " ", text: line.slice(1) });
      }
    }
  }

  return files;
}

export function parseNumstat(raw: string): DiffFileSummary[] {
  if (!raw?.trim()) return [];
  return raw.trim().split("\n").filter(Boolean).map((line) => {
    const [add, rem, ...pathParts] = line.split("\t");
    return {
      path: pathParts.join("\t"),
      additions: add === "-" ? 0 : parseInt(add, 10) || 0,
      removals: rem === "-" ? 0 : parseInt(rem, 10) || 0,
    };
  });
}

export const DiffParser = {
  parsePatch,
  parseUnifiedDiff,
  parseNumstat,
};
