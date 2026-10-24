/**
 * Markdown Content
 *
 * Lit component that renders markdown text with mermaid diagram support.
 * Owns the full lifecycle: marked parsing, mermaid code block detection,
 * and lazy-loading the mermaid library to render diagrams after DOM update.
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
import { marked, type MarkedExtension } from "marked";
import { InlineViewsController } from "../controllers/inline-views-controller.js";
import { getSharedHighlighter } from "../models/changes/shared-highlighter.js";
import { decoratedMarkdown, type DecoratedHtml } from "../models/decorated-html.js";
import { scanSettledMarkdown } from "../models/streaming-markdown.js";
import { streamingTelemetry } from "../models/streaming-telemetry.js";
import type { BoundDecorators } from "../sdk-host/decorators.js";
import { openImageViewerEvent, type OpenImageViewerDetail } from "./events.js";
import "./view-mount.js";

// ---------------------------------------------------------------------------
// Marked configuration — runs once at module load
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const mermaidExtension: MarkedExtension = {
  renderer: {
    code({ text, lang }) {
      if (lang === "mermaid") {
        return `<div class="mermaid">${escapeHtml(text)}</div>`;
      }
      if (lang) {
        return `<pre><code data-lang="${escapeHtml(lang)}">${escapeHtml(text)}</code></pre>`;
      }
      // Return false to fall through to the default renderer
      return false;
    },
  },
};

marked.use({
  breaks: true,
  gfm: true,
  extensions: [],
});
marked.use(mermaidExtension);

// ---------------------------------------------------------------------------
// Public helper — pure markdown→HTML, exported for testing
// ---------------------------------------------------------------------------

/** Parse markdown to HTML. Mermaid fenced code blocks become `<div class="mermaid">`. */
export function parseMarkdown(text: string): string {
  return marked.parse(text, { async: false });
}

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
// Mermaid lazy-loader
// ---------------------------------------------------------------------------

let mermaidReady: Promise<typeof import("mermaid")["default"]> | null = null;

async function ensureMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: "dark" });
      return m.default;
    });
  }
  return mermaidReady;
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
      return html`<div class="prose prose-invert prose-sm max-w-none break-words leading-relaxed" @click=${this._handleClick}>${this._renderContent()}</div>`;
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

    this._highlightCodeBlocks();
    await this._renderMermaid();
  }

  /** Syntax-highlight fenced code blocks via the shared Shiki worker. */
  private _highlightCodeBlocks() {
    const codeEls = this.querySelectorAll<HTMLElement>("pre code[data-lang]");
    if (codeEls.length === 0) return;

    const highlighter = getSharedHighlighter();

    for (const codeEl of codeEls) {
      if (codeEl.hasAttribute("data-highlighted")) continue;
      codeEl.setAttribute("data-highlighted", "");

      const lang = codeEl.dataset.lang;
      if (!lang) continue;

      const text = codeEl.textContent ?? "";
      highlighter.highlightCode(lang, text, (highlighted) => {
        codeEl.innerHTML = highlighted;
      });
    }
  }

  /** Render mermaid diagrams from fenced code blocks. */
  private async _renderMermaid() {
    const nodes = this.querySelectorAll<HTMLElement>("div.mermaid");
    if (nodes.length === 0) return;

    const unrendered = Array.from(nodes).filter(
      (n) => !n.hasAttribute("data-processed"),
    );
    if (unrendered.length === 0) return;

    try {
      const mermaid = await ensureMermaid();
      await mermaid.run({ nodes: unrendered });
    } catch {
      // If mermaid fails, the raw source remains visible in the div
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "markdown-content": MarkdownContent;
  }
}
