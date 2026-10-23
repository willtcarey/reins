import {
  sameSource,
  type DecorationSpan,
  type Disposer,
  type InlineContext,
  type MessageDecorator,
  type Messages,
  type Source,
  type View,
  type ViewPresentation,
  type WorkspaceContext,
} from "./contract.js";
import type { ViewRegistry } from "./view-registry.js";

/** A decorated piece: the view shown in place of its text, how, and what it is given. */
export interface InlinePiece {
  readonly view: View;
  readonly presentation: ViewPresentation<View, InlineContext>;
  readonly context: InlineContext;
}

export type DecoratedSegment = string | InlinePiece;

type InlinePresentations = (view: View) => ViewPresentation<View, InlineContext> | null;

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

/** The registered message decorators, app state on `AppStore`. */
export class DecoratorRegistry implements Messages {
  private decorators: Array<{ decorator: MessageDecorator; unsubscribe: Disposer }> = [];
  // Bumped whenever messages must be decorated again: a decorator or a view registered, gone or changed.
  private generation = 0;
  private current: { generation: number; decorators: BoundDecorators } | null = null;
  private listeners = new Set<() => void>();
  private unsubscribeViews: Disposer;

  constructor(private readonly views: ViewRegistry) {
    this.unsubscribeViews = views.subscribe(() => this.changed());
  }

  registerDecorator(decorator: MessageDecorator): Disposer {
    const registration = { decorator, unsubscribe: decorator.onChange(() => this.changed()) };
    this.decorators = [...this.decorators, registration];
    this.changed();
    return () => {
      if (!this.decorators.includes(registration)) return;
      registration.unsubscribe();
      this.decorators = this.decorators.filter((entry) => entry !== registration);
      this.changed();
    };
  }

  /**
   * Every decorator, with the context they decorate in filled in for a source (not a filter), or null
   * with none to apply. The same object until a decorator or a view changes or the source does, so
   * rendered messages keep what they parsed.
   */
  bind(source: Source | null): BoundDecorators | null {
    if (!source || this.decorators.length === 0) return null;
    const current = this.current;
    if (current?.generation === this.generation && sameSource(current.decorators.context.source, source)) return current.decorators;
    const decorators = new BoundDecorators(
      this.decorators.map(({ decorator }) => decorator),
      { source },
      (view) => this.views.rendererFor(view)?.inline ?? null,
    );
    this.current = { generation: this.generation, decorators };
    return decorators;
  }

  /** Listens for messages needing to be decorated again. */
  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribeViews();
    for (const { unsubscribe } of this.decorators) unsubscribe();
    this.decorators = [];
    this.listeners.clear();
  }

  private changed(): void {
    this.generation += 1;
    for (const listener of this.listeners) listener();
  }
}

/**
 * The registered decorators bound to a context, so they are applied to text alone: what they find
 * are the decorations. Messages are rendered with one of these and keep what they rendered while it
 * is the same object (`DecoratorRegistry.bind`).
 */
export class BoundDecorators {
  constructor(
    private readonly decorators: readonly MessageDecorator[],
    readonly context: WorkspaceContext,
    private readonly inline: InlinePresentations,
  ) {}

  /**
   * Some prose split into plain runs and decorated pieces. A piece has one view: an earlier decorator
   * wins an overlap, and a view without an inline presentation leaves its text alone.
   */
  segments(text: string): DecoratedSegment[] {
    const spans: Array<DecorationSpan & { presentation: ViewPresentation<View, InlineContext> }> = [];
    for (const decorator of this.decorators) {
      for (const span of decorator.decorate(text, this.context)) {
        if (span.start < 0 || span.end > text.length || span.start >= span.end) continue;
        if (spans.some((taken) => span.start < taken.end && taken.start < span.end)) continue;
        const presentation = this.inline(span.view);
        if (presentation) spans.push({ ...span, presentation });
      }
    }
    spans.sort((a, b) => a.start - b.start);
    const segments: DecoratedSegment[] = [];
    let last = 0;
    for (const { start, end, view, presentation } of spans) {
      if (start > last) segments.push(text.slice(last, start));
      segments.push(this.piece(text.slice(start, end), false, view, presentation));
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

  /** The piece a whole inline-code span is, from the first decorator with a view for it that can be shown inline. */
  code(text: string): InlinePiece | null {
    for (const decorator of this.decorators) {
      const view = decorator.decorateCode?.(text, this.context);
      const presentation = view ? this.inline(view) : null;
      if (view && presentation) return this.piece(text, true, view, presentation);
    }
    return null;
  }

  private piece(text: string, code: boolean, view: View, presentation: ViewPresentation<View, InlineContext>): InlinePiece {
    const original = (): Node => {
      if (!code) return document.createTextNode(text);
      const element = document.createElement("code");
      element.textContent = text;
      return element;
    };
    return { view, presentation, context: { ...this.context, text, code, original } };
  }
}
