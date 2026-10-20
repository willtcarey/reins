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
import type { FileReference, FileReferenceIndex } from "../models/file-references.js";
import type { ViewOf } from "../models/inspector.js";
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

function lineLabel({ startLine, endLine }: FileReference): string {
  if (startLine == null) return "";
  return endLine == null ? `:${startLine}` : `:${startLine}-${endLine}`;
}

/** A file reference renders as a button around its original text, which `<markdown-content>` opens. */
const fileReferenceExtension: MarkedExtension = {
  extensions: [{
    name: "fileReference",
    renderer(token) {
      const reference: FileReference = token.reference;
      const content = token.code
        ? this.parser.renderer.codespan({ type: "codespan", raw: token.raw, text: token.text })
        : this.parser.renderer.text({ type: "text", raw: token.raw, text: token.text });
      const lines = [
        reference.startLine == null ? "" : ` data-start-line="${reference.startLine}"`,
        reference.endLine == null ? "" : ` data-end-line="${reference.endLine}"`,
      ].join("");
      const title = escapeHtml(`Open ${reference.path}${lineLabel(reference)} in the Inspector`);
      return `<button type="button" class="file-reference" data-file-reference data-path="${escapeHtml(reference.path)}"${lines} title="${title}">${content}</button>`;
    },
  }],
};

marked.use({
  breaks: true,
  gfm: true,
  extensions: [],
});
marked.use(mermaidExtension);
marked.use(fileReferenceExtension);

function fileReferenceToken(text: string, reference: FileReference, code: boolean): Tokens.Generic {
  return { type: "fileReference", raw: text, text, reference, code };
}

/**
 * Replaces the text of prose and inline code that names a file with file reference tokens. Code
 * blocks, HTML, links and images keep their own semantics and are left as they are.
 */
function decorateTokens(tokens: Token[], references: FileReferenceIndex): Token[] {
  return tokens.flatMap((token): Token[] => {
    switch (token.type) {
      case "code":
      case "html":
      case "link":
      case "image":
        return [token];
      case "codespan": {
        const reference = references.resolve(token.text.trim());
        return reference ? [fileReferenceToken(token.text, reference, true)] : [token];
      }
      case "text": {
        if (token.tokens) {
          token.tokens = decorateTokens(token.tokens, references);
          return [token];
        }
        if (token.escaped) return [token];
        return references.segments(token.text).map((segment): Token => (typeof segment === "string"
          ? { type: "text", raw: segment, text: segment }
          : fileReferenceToken(segment.text, segment.reference, false)));
      }
      case "table":
        for (const cell of [...token.header, ...token.rows.flat()]) cell.tokens = decorateTokens(cell.tokens, references);
        return [token];
      case "list":
        for (const item of token.items) item.tokens = decorateTokens(item.tokens, references);
        return [token];
      default:
        if ("tokens" in token && token.tokens) token.tokens = decorateTokens(token.tokens, references);
        return [token];
    }
  });
}

// ---------------------------------------------------------------------------
// Public helper — pure markdown→HTML, exported for testing
// ---------------------------------------------------------------------------

/**
 * Parse markdown to HTML. Mermaid fenced code blocks become `<div class="mermaid">`. With
 * `references`, files named in the text become file reference buttons.
 */
export function parseMarkdown(text: string, references?: FileReferenceIndex | null): string {
  if (!references) return marked.parse(text, { async: false });
  return marked.parser(decorateTokens(marked.lexer(text), references));
}

/** The file view a click on a file reference asks for, or null for any other target. */
export function fileViewFromReferenceTarget(target: unknown): ViewOf<"file"> | null {
  if (typeof target !== "object" || target === null || !("closest" in target) || typeof target.closest !== "function") return null;
  const element: unknown = target.closest("[data-file-reference]");
  if (typeof element !== "object" || element === null || !("dataset" in element)) return null;
  const dataset: unknown = element.dataset;
  const path: unknown = typeof dataset === "object" && dataset !== null ? Reflect.get(dataset, "path") : null;
  if (typeof path !== "string" || !path) return null;
  const startLine = Number(Reflect.get(Object(dataset), "startLine"));
  const endLine = Number(Reflect.get(Object(dataset), "endLine"));
  return {
    view: "file",
    path,
    ...(startLine > 0 ? { startLine } : {}),
    ...(endLine > 0 ? { endLine } : {}),
  };
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

  /** Files of the viewed checkout; files a completed text names become controls that open them. */
  @property({ attribute: false })
  references: FileReferenceIndex | null = null;

  private _segments = new StreamingMarkdownSegments();
  private _parsed: { text: string; references: FileReferenceIndex | null; html: string } | null = null;

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
    const { text, references } = this;
    if (this._parsed?.text !== text || this._parsed.references !== references) {
      this._parsed = { text, references, html: parseMarkdown(text, references) };
    }
    return { settled: [], tail: this._parsed.html };
  }

  private _handleClick = (event: MouseEvent) => {
    const view = fileViewFromReferenceTarget(event.target);
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
