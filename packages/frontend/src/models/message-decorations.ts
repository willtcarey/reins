/**
 * Decorations of completed message text: pieces of it that become controls opening a view. Each
 * decorator finds its own targets; splitting text by them, Markdown's token walk (in
 * `markdown-content`) and user messages' plain text are shared. Decorators are looked up the way
 * views are; how plugins add them is not decided yet, so the lookup stays internal.
 */

import { fileReferenceDecorator } from "./file-references.js";
import type { View } from "./inspector.js";
import type { FileSource, ProjectFiles } from "./stores/project-files.js";

export interface Decoration {
  view: View;
  /** What activating it does, for its tooltip. */
  title: string;
}

export interface DecorationTarget extends Decoration {
  start: number;
  end: number;
}

export interface MessageDecorator {
  /** Its targets in a piece of prose, in order and not overlapping. */
  find(text: string): DecorationTarget[];
  /** The decoration a whole inline-code span is, if it is one. */
  resolveCode?(code: string): Decoration | null;
}

export type DecoratedSegment = string | (Decoration & { text: string });

/** What decorators are given to find their targets: the viewed session's files. */
export interface DecoratorContext {
  files: ProjectFiles;
  source: FileSource | null;
}

/** Each returns the same decorator for as long as what it decorates from is unchanged, or null for none. */
const DECORATORS: Record<string, (context: DecoratorContext) => MessageDecorator | null> = {
  "file-references": fileReferenceDecorator,
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

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

export class MessageDecorations {
  constructor(readonly decorators: readonly MessageDecorator[]) {}

  /** A piece of prose split into plain runs and decorations; an earlier decorator wins an overlap. */
  segments(text: string): DecoratedSegment[] {
    const targets: DecorationTarget[] = [];
    for (const decorator of this.decorators) {
      for (const target of decorator.find(text)) {
        if (!targets.some((taken) => target.start < taken.end && taken.start < target.end)) targets.push(target);
      }
    }
    targets.sort((a, b) => a.start - b.start);
    const segments: DecoratedSegment[] = [];
    let last = 0;
    for (const { start, end, view, title } of targets) {
      if (start > last) segments.push(text.slice(last, start));
      segments.push({ text: text.slice(start, end), view, title });
      last = end;
    }
    if (last < text.length) segments.push(text.slice(last));
    return segments;
  }

  /** User messages are plain text, not Markdown: everything but fenced code blocks is prose. */
  plainText(text: string): DecoratedSegment[] {
    const segments: DecoratedSegment[] = [];
    for (const region of unfencedRegions(text)) {
      for (const segment of region.fenced ? [region.text] : this.segments(region.text)) {
        const previous = segments.at(-1);
        if (typeof segment === "string" && typeof previous === "string") segments[segments.length - 1] = previous + segment;
        else segments.push(segment);
      }
    }
    return segments;
  }

  /** The decoration a whole inline-code span is, from the first decorator that resolves it. */
  code(text: string): Decoration | null {
    for (const decorator of this.decorators) {
      const decoration = decorator.resolveCode?.(text);
      if (decoration) return decoration;
    }
    return null;
  }
}

let current: MessageDecorations | null = null;

/**
 * The decorations for messages of the viewed session, or null when no decorator has anything to
 * find. The same object while every decorator is unchanged, so rendered messages can keep theirs.
 */
export function messageDecorations(context: DecoratorContext): MessageDecorations | null {
  const found: MessageDecorator[] = [];
  for (const decorator of Object.values(DECORATORS)) {
    const active = decorator(context);
    if (active) found.push(active);
  }
  if (found.length === 0) return null;
  if (current?.decorators.length !== found.length || current.decorators.some((decorator, index) => decorator !== found[index])) {
    current = new MessageDecorations(found);
  }
  return current;
}
