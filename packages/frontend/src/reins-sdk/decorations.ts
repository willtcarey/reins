import type { Decoration, DecorationSpan, MessageDecorator, View, WorkspaceContext } from "./contract.js";

export type DecoratedSegment = string | (Decoration & { text: string });

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

/**
 * The registered decorators applied for one context. Messages are rendered with one of these and
 * keep what they rendered while it is the same object (`ReinsHost.decorations`).
 */
export class MessageDecorations {
  constructor(
    private readonly decorators: readonly MessageDecorator[],
    readonly context: WorkspaceContext,
    private readonly opener: (view: View) => void,
  ) {}

  /** Some prose split into plain runs and decorations; an earlier decorator wins an overlap. */
  segments(text: string): DecoratedSegment[] {
    const spans: DecorationSpan[] = [];
    for (const decorator of this.decorators) {
      for (const span of decorator.decorate(text, this.context)) {
        if (span.start < 0 || span.end > text.length || span.start >= span.end) continue;
        if (!spans.some((taken) => span.start < taken.end && taken.start < span.end)) spans.push(span);
      }
    }
    spans.sort((a, b) => a.start - b.start);
    const segments: DecoratedSegment[] = [];
    let last = 0;
    for (const { start, end, view, label } of spans) {
      if (start > last) segments.push(text.slice(last, start));
      segments.push({ text: text.slice(start, end), view, label });
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

  /** The decoration a whole inline-code span is, from the first decorator that has one. */
  code(text: string): Decoration | null {
    for (const decorator of this.decorators) {
      const decoration = decorator.decorateCode?.(text, this.context);
      if (decoration) return decoration;
    }
    return null;
  }

  /** Activates a decoration: opens its view in the Inspector. */
  open(view: View): void {
    this.opener(view);
  }
}
