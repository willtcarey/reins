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
  /** The file's path before a rename or move. */
  oldPath?: string;
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

/**
 * Parse `git diff --numstat -z`. Each entry is `<added>\t<removed>\t<path>\0`, or for a rename
 * `<added>\t<removed>\t\0<old path>\0<new path>\0`. Paths are not quoted. Binary files count `-`.
 */
export function parseNumstat(raw: string): DiffFileSummary[] {
  const fields = raw.split("\0");
  const files: DiffFileSummary[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const firstTab = field.indexOf("\t");
    const secondTab = field.indexOf("\t", firstTab + 1);
    const counts = {
      additions: count(field.slice(0, firstTab)),
      removals: count(field.slice(firstTab + 1, secondTab)),
    };
    const path = field.slice(secondTab + 1);
    if (path) {
      files.push({ path, ...counts });
    } else {
      files.push({ path: fields[i + 2], oldPath: fields[i + 1], ...counts });
      i += 2;
    }
  }
  return files;
}

function count(value: string): number {
  return value === "-" ? 0 : parseInt(value, 10) || 0;
}

export const DiffParser = {
  parsePatch,
  parseUnifiedDiff,
  parseNumstat,
};
