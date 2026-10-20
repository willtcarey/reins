/**
 * File references in message text: which words name a file of the checkout, and which lines.
 * Built from the file listing; a reference counts only when it resolves to a listed file.
 */

import { isBrowsablePath, toRelativePath } from "./path-utils.js";

export interface FileReference {
  path: string;
  startLine?: number;
  endLine?: number;
}

export type ReferenceSegment = string | { text: string; reference: FileReference };

// `path:12`, `path:12-20`, `path:12:5` (a column), `path#L12`, `path#L12-L20`.
const LINE_SUFFIX = /^(.+?)(?::(\d+)(?:[-–](\d+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)$/;
const LEADING = new Set(["(", "[", "{", "<", "\"", "'", "`", "*"]);
const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", ">", "\"", "'", "`", "*"]);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function lines(start: string | undefined, end: string | undefined): Pick<FileReference, "startLine" | "endLine"> {
  const startLine = Number(start);
  if (!start || startLine < 1) return {};
  const endLine = Number(end);
  if (!end || endLine === startLine) return { startLine };
  return endLine > startLine ? { startLine, endLine } : { startLine: endLine, endLine: startLine };
}

/** Text split at fenced code blocks, which are never decorated. */
function* unfencedRegions(text: string): Generator<{ text: string; fenced: boolean }> {
  let fence: string | null = null;
  let region = "";
  let regionFenced = false;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = FENCE.exec(line)?.[1];
    const fenced = fence != null || marker != null;
    if (fenced !== regionFenced && region) {
      yield { text: region, fenced: regionFenced };
      region = "";
    }
    regionFenced = fenced;
    region += line;
    if (marker && fence == null) fence = marker[0]!;
    else if (marker && fence != null && marker[0] === fence) fence = null;
  }
  if (region) yield { text: region, fenced: regionFenced };
}

export class FileReferenceIndex {
  private paths: Set<string>;
  // A basename two files share maps to null: it names neither.
  private basenames = new Map<string, string | null>();
  private resolved = new Map<string, FileReference | null>();

  constructor(files: readonly string[], private checkoutPath: string | null) {
    this.paths = new Set(files);
    for (const path of files) {
      const basename = path.slice(path.lastIndexOf("/") + 1);
      this.basenames.set(basename, this.basenames.has(basename) ? null : path);
    }
  }

  /** The file a whole piece of text names (such as inline code), or null. */
  resolve(text: string): FileReference | null {
    let reference = this.resolved.get(text);
    if (reference === undefined) {
      reference = this.lookup(text);
      this.resolved.set(text, reference);
    }
    return reference;
  }

  /** Text split into plain runs and the file references in it. */
  segments(text: string): ReferenceSegment[] {
    const segments: ReferenceSegment[] = [];
    let plain = "";
    for (const region of unfencedRegions(text)) {
      if (region.fenced) {
        plain += region.text;
        continue;
      }
      let last = 0;
      for (const word of region.text.matchAll(/\S+/g)) {
        const found = this.find(word[0]);
        if (!found) continue;
        const start = word.index + found.start;
        plain += region.text.slice(last, start);
        if (plain) segments.push(plain);
        plain = "";
        segments.push({ text: word[0].slice(found.start, found.end), reference: found.reference });
        last = word.index + found.end;
      }
      plain += region.text.slice(last);
    }
    if (plain) segments.push(plain);
    return segments;
  }

  /** The longest reference in a word, leaving out the punctuation around it. */
  private find(word: string): { start: number; end: number; reference: FileReference } | null {
    if (!/[./]/.test(word) || word.includes("://")) return null;
    let start = 0;
    while (start < word.length && LEADING.has(word[start]!)) start += 1;
    for (let end = word.length; end > start; end -= 1) {
      const reference = this.resolve(word.slice(start, end));
      if (reference) return { start, end, reference };
      if (!TRAILING.has(word[end - 1]!)) return null;
    }
    return null;
  }

  private lookup(text: string): FileReference | null {
    if (text.includes("://")) return null;
    const suffix = LINE_SUFFIX.exec(text);
    const path = this.projectPath(suffix ? suffix[1]! : text);
    if (!path) return null;
    const found = this.paths.has(path) ? path : path.includes("/") ? null : this.basenames.get(path);
    if (!found) return null;
    if (!suffix) return { path: found };
    return { path: found, ...lines(suffix[2] ?? suffix[4], suffix[3] ?? suffix[5]) };
  }

  private projectPath(text: string): string | null {
    const relative = toRelativePath(text, this.checkoutPath).replace(/^\.\//, "");
    if (!relative || !isBrowsablePath(relative, null)) return null;
    return relative;
  }
}
