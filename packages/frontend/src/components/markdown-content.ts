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
 * Uses light DOM for Tailwind compatibility.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked, type MarkedExtension } from "marked";

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
  return marked.parse(text, { async: false }) as string;
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

  override render() {
    try {
      const rendered = parseMarkdown(this.text);
      return html`<div class="prose prose-invert prose-sm max-w-none break-words leading-relaxed">${unsafeHTML(rendered)}</div>`;
    } catch {
      return html`<pre class="whitespace-pre-wrap text-sm">${this.text}</pre>`;
    }
  }

  override async updated() {
    if (this.streaming) return;

    const nodes = this.querySelectorAll<HTMLElement>("div.mermaid");
    if (nodes.length === 0) return;

    // Skip nodes already rendered by mermaid
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
