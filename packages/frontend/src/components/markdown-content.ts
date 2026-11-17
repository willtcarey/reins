/**
 * Markdown Content
 *
 * The chat's Markdown: the app's renderer (markdown-rendering.ts, which extensions' `<reins-markdown>` shares),
 * with what only the chat has: streaming, message decorators and the image viewer.
 *
 * Usage:
 *   <markdown-content .text=${someMarkdown}></markdown-content>
 *   <markdown-content .text=${streamingText} .streaming=${true}></markdown-content>
 *
 * While streaming, text is rendered as settled block segments plus a live
 * tail. Each segment is parsed once and its unsafeHTML part is left untouched
 * by Lit on later updates, so each token re-parses only the tail. When
 * streaming ends the whole text is rendered unsplit, which is authoritative.
 *
 * Uses light DOM for Tailwind compatibility.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { InlineViewsController } from "../controllers/inline-views-controller.js";
import { decoratedMarkdown, type DecoratedHtml } from "../models/decorated-html.js";
import { scanSettledMarkdown } from "../models/streaming-markdown.js";
import { streamingTelemetry } from "../models/streaming-telemetry.js";
import type { BoundDecorators } from "../sdk-host/decorators.js";
import { openImageViewerEvent, type OpenImageViewerDetail } from "./events.js";
import { MARKDOWN_CLASSES, parseMarkdown, renderCodeAndDiagrams } from "./markdown-rendering.js";
import "./view-mount.js";

/** Build an image-viewer event payload from a clicked markdown image target. */
export function imageViewerDetailFromMarkdownTarget(target: unknown): OpenImageViewerDetail | null {
  if (typeof target !== "object" || target === null) return null;
  const candidate: {
    tagName?: unknown;
    nodeName?: unknown;
    currentSrc?: unknown;
    src?: unknown;
    alt?: unknown;
    title?: unknown;
  } = target;
  const tagName = typeof candidate.tagName === "string"
    ? candidate.tagName
    : typeof candidate.nodeName === "string"
      ? candidate.nodeName
      : "";
  const isImage = tagName.toUpperCase() === "IMG"
    || (typeof HTMLImageElement !== "undefined" && target instanceof HTMLImageElement);
  if (!isImage) return null;

  const currentSrc = typeof candidate.currentSrc === "string" ? candidate.currentSrc : "";
  const fallbackSrc = typeof candidate.src === "string" ? candidate.src : "";
  const src = currentSrc || fallbackSrc;
  if (!src) return null;

  const alt = typeof candidate.alt === "string" && candidate.alt ? candidate.alt : "Image preview";
  const title = typeof candidate.title === "string" && candidate.title ? candidate.title : alt;
  return { src, alt, title };
}

// ---------------------------------------------------------------------------
// Streaming segments
// ---------------------------------------------------------------------------

interface StreamingMarkdownParts {
  settled: readonly string[];
  tail: string;
}

/** Incrementally settles a growing markdown text into parsed block segments. */
class StreamingMarkdownSegments {
  private settledText = "";
  private settledHtml: string[] = [];
  private splittable = true;

  render(text: string): StreamingMarkdownParts {
    const startedAt = performance.now();
    if (!text.startsWith(this.settledText)) this.reset();
    let parsedLength = 0;
    if (this.splittable) {
      const scan = scanSettledMarkdown(text, this.settledText.length);
      if (!scan.splittable) {
        this.reset();
        this.splittable = false;
      } else if (scan.boundary > this.settledText.length) {
        const segment = text.slice(this.settledText.length, scan.boundary);
        this.settledHtml = [...this.settledHtml, parseMarkdown(segment)];
        this.settledText = text.slice(0, scan.boundary);
        parsedLength += segment.length;
      }
    }
    const tail = text.slice(this.settledText.length);
    const tailHtml = parseMarkdown(tail);
    parsedLength += tail.length;
    streamingTelemetry.markdownParsed(performance.now() - startedAt, text.length, parsedLength);
    return { settled: this.settledHtml, tail: tailHtml };
  }

  reset(): void {
    this.settledText = "";
    this.settledHtml = [];
    this.splittable = true;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("markdown-content")
export class MarkdownContent extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** The raw markdown text to render. */
  @property({ attribute: false })
  text = "";

  /** When true, skip mermaid rendering (text is still streaming in). */
  @property({ type: Boolean })
  streaming = false;

  /** The decorators applied to a completed text: what they find is shown as views in place of pieces of it. */
  @property({ attribute: false })
  decorators: BoundDecorators | null = null;

  private _segments = new StreamingMarkdownSegments();
  private _parsed: { text: string; decorators: BoundDecorators | null; html: string | DecoratedHtml } | null = null;
  private _inlineViews = new InlineViewsController(this);

  override render() {
    try {
      return html`<div class=${MARKDOWN_CLASSES} @click=${this._handleClick}>${this._renderContent()}</div>`;
    } catch {
      this._segments.reset();
      return html`<pre class="whitespace-pre-wrap text-sm">${this.text}</pre>`;
    }
  }

  private _renderContent() {
    if (this.streaming) {
      const parts = this._segments.render(this.text);
      return html`${parts.settled.map((segment) => unsafeHTML(segment))}${unsafeHTML(parts.tail)}`;
    }
    this._segments.reset();
    const { text, decorators } = this;
    if (this._parsed?.text !== text || this._parsed.decorators !== decorators) {
      this._parsed = { text, decorators, html: decorators ? decoratedMarkdown(text, decorators) : parseMarkdown(text) };
    }
    const parsed = this._parsed.html;
    return typeof parsed === "string" ? unsafeHTML(parsed) : this._inlineViews.render(parsed);
  }

  private _handleClick = (event: MouseEvent) => {
    const detail = imageViewerDetailFromMarkdownTarget(event.target);
    if (!detail) return;

    event.preventDefault();
    event.stopPropagation();
    this.dispatchEvent(openImageViewerEvent(detail));
  };

  override async updated() {
    if (this.streaming) return;
    await renderCodeAndDiagrams(this);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "markdown-content": MarkdownContent;
  }
}
