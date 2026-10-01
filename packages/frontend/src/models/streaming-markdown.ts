/**
 * Settled-prefix detection for streaming markdown.
 *
 * A streaming message is rendered as settled block segments plus a live tail.
 * A boundary is safe only when rendering the text before and after it
 * separately produces the same HTML as rendering it whole, whatever text
 * arrives later. Detection is deliberately conservative: when in doubt it does
 * not split, which only costs a larger re-parse.
 */

export interface SettledMarkdownScan {
  /**
   * Offset just past the last safe block boundary found at or after `from`,
   * or `from` itself when the scanned text has no safe boundary.
   */
  boundary: number;
  /**
   * False when the scanned text contains a construct whose rendering can
   * reach across block boundaries (link reference definitions, raw HTML
   * blocks). The whole message must then be parsed as one unit.
   */
  splittable: boolean;
}

const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})\s*$/;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:/;
// Raw HTML blocks can span blank lines and unbalanced tags would be closed
// per segment. Autolinks such as <https://…> are inline, not HTML blocks.
const HTML_BLOCK_START = /^<(?![a-z][a-z0-9+.-]*:)[a-z!?/]/i;
const BLOCKQUOTE_PREFIX = /^(?:>\s?)+/;

interface OpenFence {
  char: string;
  length: number;
  indent: number;
}

function leadingWhitespace(line: string): number {
  return line.length - line.trimStart().length;
}

function openFence(line: string): OpenFence | null {
  const trimmed = line.trimStart();
  const match = FENCE_OPEN.exec(trimmed);
  if (!match) return null;
  const marker = match[1]!;
  const info = match[2] ?? "";
  // Backtick fence info strings cannot contain backticks (``` x ``` is inline code).
  if (marker[0] === "`" && info.includes("`")) return null;
  return { char: marker[0]!, length: marker.length, indent: leadingWhitespace(line) };
}

function closesFence(line: string, fence: OpenFence): boolean {
  if (leadingWhitespace(line) > fence.indent + 3) return false;
  const match = FENCE_CLOSE.exec(line.trimStart());
  const marker = match?.[1];
  return marker !== undefined && marker[0] === fence.char && marker.length >= fence.length;
}

/**
 * Scan `text` from `from`, which must itself be a safe boundary (0 or a
 * previously returned boundary). Only newline-terminated lines are
 * considered; the incomplete final line never settles.
 *
 * A blank line is a safe boundary when it is outside fenced code and `$$`
 * math, and the block before it is not a list, list continuation, or
 * indented code (any of which can continue across the blank line).
 */
export function scanSettledMarkdown(text: string, from = 0): SettledMarkdownScan {
  let boundary = from;
  let fence: OpenFence | null = null;
  let inMath = false;
  let blockHasContent = false;
  let blockUnsafe = false;
  let position = from;

  while (position < text.length) {
    const newline = text.indexOf("\n", position);
    if (newline === -1) {
      // The incomplete final line cannot settle, but can already disable splitting.
      const line = text.slice(position);
      if (!fence && !inMath && (REFERENCE_DEFINITION.test(line) || HTML_BLOCK_START.test(line.trimStart()))) {
        return { boundary: from, splittable: false };
      }
      break;
    }
    const line = text.slice(position, newline);
    position = newline + 1;

    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (inMath) {
      if (line.includes("$$")) inMath = false;
      continue;
    }

    const trimmed = line.trimStart();
    if (trimmed === "") {
      if (blockHasContent && !blockUnsafe) boundary = position;
      blockHasContent = false;
      blockUnsafe = false;
      continue;
    }

    if (REFERENCE_DEFINITION.test(line) || HTML_BLOCK_START.test(trimmed)) {
      return { boundary: from, splittable: false };
    }

    if (!blockHasContent) {
      blockHasContent = true;
      // Indented blocks may be list continuations or indented code.
      if (trimmed.length !== line.length) blockUnsafe = true;
    }
    if (LIST_MARKER.test(trimmed.replace(BLOCKQUOTE_PREFIX, ""))) blockUnsafe = true;

    fence = openFence(line);
    if (fence) continue;
    if (trimmed.startsWith("$$") && !trimmed.slice(2).includes("$$")) inMath = true;
  }

  return { boundary, splittable: true };
}
