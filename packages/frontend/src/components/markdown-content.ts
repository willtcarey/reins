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
import { marked, type MarkedExtension, type Token, type Tokens } from "marked";
import { getSharedHighlighter } from "../models/changes/shared-highlighter.js";
import { parseView, type View } from "../models/inspector.js";
import type { Decoration, MessageDecorations } from "../models/message-decorations.js";
import { scanSettledMarkdown } from "../models/streaming-markdown.js";
import { streamingTelemetry } from "../models/streaming-telemetry.js";
import { openImageViewerEvent, openViewEvent, type OpenImageViewerDetail } from "./events.js";

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

/** A decoration renders as a button around its original text, holding the view `<markdown-content>` opens. */
const decorationExtension: MarkedExtension = {
  extensions: [{
    name: "decoration",
    renderer(token) {
      const decoration: Decoration = token.decoration;
      const content = token.code
        ? this.parser.renderer.codespan({ type: "codespan", raw: token.raw, text: token.text })
        : this.parser.renderer.text({ type: "text", raw: token.raw, text: token.text });
      return `<button type="button" class="message-decoration" data-view="${escapeHtml(JSON.stringify(decoration.view))}" title="${escapeHtml(decoration.title)}">${content}</button>`;
    },
  }],
};

marked.use({
  breaks: true,
  gfm: true,
  extensions: [],
});
marked.use(mermaidExtension);
marked.use(decorationExtension);

function decorationToken(text: string, decoration: Decoration, code: boolean): Tokens.Generic {
  return { type: "decoration", raw: text, text, decoration, code };
}

/**
 * Replaces what decorators find in prose and inline code with decoration tokens. Code blocks, HTML,
 * links and images keep their own semantics and are left as they are.
 */
function decorateTokens(tokens: Token[], decorations: MessageDecorations): Token[] {
  return tokens.flatMap((token): Token[] => {
    switch (token.type) {
      case "code":
      case "html":
      case "link":
      case "image":
        return [token];
      case "codespan": {
        const decoration = decorations.code(token.text);
        return decoration ? [decorationToken(token.text, decoration, true)] : [token];
      }
      case "text": {
        if (token.tokens) {
          token.tokens = decorateTokens(token.tokens, decorations);
          return [token];
        }
        if (token.escaped) return [token];
        return decorations.segments(token.text).map((segment): Token => (typeof segment === "string"
          ? { type: "text", raw: segment, text: segment }
          : decorationToken(segment.text, segment, false)));
      }
      case "table":
        for (const cell of [...token.header, ...token.rows.flat()]) cell.tokens = decorateTokens(cell.tokens, decorations);
        return [token];
      case "list":
        for (const item of token.items) item.tokens = decorateTokens(item.tokens, decorations);
        return [token];
      default:
        if ("tokens" in token && token.tokens) token.tokens = decorateTokens(token.tokens, decorations);
        return [token];
    }
  });
}

// ---------------------------------------------------------------------------
// Public helper — pure markdown→HTML, exported for testing
// ---------------------------------------------------------------------------

/**
 * Parse markdown to HTML. Mermaid fenced code blocks become `<div class="mermaid">`. With
 * `decorations`, what decorators find becomes buttons that open views.
 */
export function parseMarkdown(text: string, decorations?: MessageDecorations | null): string {
  if (!decorations) return marked.parse(text, { async: false });
  return marked.parser(decorateTokens(marked.lexer(text), decorations));
}

/** The view a click on a decoration asks for, or null for any other target. */
export function viewFromDecorationTarget(target: unknown): View | null {
  if (typeof target !== "object" || target === null || !("closest" in target) || typeof target.closest !== "function") return null;
  const element: unknown = target.closest("[data-view]");
  if (typeof element !== "object" || element === null || !("dataset" in element)) return null;
  const dataset: unknown = element.dataset;
  const json: unknown = typeof dataset === "object" && dataset !== null ? Reflect.get(dataset, "view") : null;
  if (typeof json !== "string") return null;
  try {
    return parseView(JSON.parse(json));
  } catch {
    return null;
  }
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

  /** What a completed text is decorated with: pieces of it become controls that open views. */
  @property({ attribute: false })
  decorations: MessageDecorations | null = null;

  private _segments = new StreamingMarkdownSegments();
  private _parsed: { text: string; decorations: MessageDecorations | null; html: string } | null = null;

  override render() {
    try {
      const parts = this._renderParts();
      return html`<div class="prose prose-invert prose-sm max-w-none break-words leading-relaxed" @click=${this._handleClick}>${parts.settled.map((segment) => unsafeHTML(segment))}${unsafeHTML(parts.tail)}</div>`;
    } catch {
      this._segments.reset();
      return html`<pre class="whitespace-pre-wrap text-sm">${this.text}</pre>`;
    }
  }

  private _renderParts(): StreamingMarkdownParts {
    if (this.streaming) return this._segments.render(this.text);
    this._segments.reset();
    const { text, decorations } = this;
    if (this._parsed?.text !== text || this._parsed.decorations !== decorations) {
      this._parsed = { text, decorations, html: parseMarkdown(text, decorations) };
    }
    return { settled: [], tail: this._parsed.html };
  }

  private _handleClick = (event: MouseEvent) => {
    const view = viewFromDecorationTarget(event.target);
    if (view) {
      event.preventDefault();
      event.stopPropagation();
      this.dispatchEvent(openViewEvent(view, { in: "inspector" }));
      return;
    }
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
