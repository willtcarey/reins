/**
 * The app's one Markdown renderer: the chat's `<markdown-content>` and extensions' `<reins-markdown>` both draw
 * with it, so they look the same. marked parses (fenced Mermaid blocks become `<div class="mermaid">`), and once
 * the HTML is on the page, `renderCodeAndDiagrams` highlights code blocks with the shared Shiki worker and draws
 * Mermaid diagrams, loading Mermaid only when a text has one.
 */

import { Marked, marked, type MarkedExtension } from "marked";
import { getSharedHighlighter } from "../models/changes/shared-highlighter.js";

/** The classes of the element that holds the rendered HTML: the chat's prose look (app.css *Markdown prose*). */
export const MARKDOWN_CLASSES = "prose prose-invert prose-sm max-w-none break-words leading-relaxed";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

/** What a browser reads in an attribute for the character references marked leaves in a URL. A named one not
 * listed stays as it is, and is then escaped, so it can never become a character. */
function decodeReferences(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (reference, decimal?: string, hex?: string, name?: string) => {
    const code = decimal ? Number.parseInt(decimal, 10) : hex ? Number.parseInt(hex, 16) : null;
    if (code !== null) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
    return ENTITIES[name ?? ""] ?? reference;
  });
}

const RELATIVE = new URL("https://relative.invalid/");

/** The URL to write, escaped, if its scheme is one of `schemes` or it has none (relative to the page); and whether
 * it leaves the page. */
function checkUrl(href: string, schemes: readonly string[]): { href: string; external: boolean } | null {
  let value: string;
  let url: URL;
  try {
    // As marked's own renderer writes it.
    value = encodeURI(decodeReferences(href)).replace(/%25/g, "%");
    // The browser's parser, so what is checked is what a click would open.
    url = new URL(value, RELATIVE);
  } catch {
    return null;
  }
  if (url.origin === RELATIVE.origin) return { href: escapeHtml(value), external: false };
  if (!schemes.includes(url.protocol)) return null;
  return { href: escapeHtml(value), external: url.protocol === "http:" || url.protocol === "https:" };
}

function linkHtml(url: { href: string; external: boolean }, title: string | null | undefined, text: string): string {
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
  const newTab = url.external ? ` target="_blank" rel="noopener noreferrer"` : "";
  return `<a href="${url.href}"${titleAttribute}${newTab}>${text}</a>`;
}

const OPTIONS: MarkedExtension = { breaks: true, gfm: true };

const codeBlocks: MarkedExtension = {
  renderer: {
    code({ text, lang }) {
      if (lang === "mermaid") {
        return `<div class="mermaid">${escapeHtml(text)}</div>`;
      }
      if (lang) {
        return `<pre><code data-lang="${escapeHtml(lang)}">${escapeHtml(text)}</code></pre>`;
      }
      return false;
    },
  },
};

// The global instance is the chat's: decorated-html.ts adds its decorations to it.
marked.use(OPTIONS, codeBlocks, {
  renderer: {
    // A link that leaves the page opens in a new tab, so it never replaces the app. Others are marked's own.
    link({ href, title, tokens }) {
      const url = checkUrl(href, ["http:", "https:"]);
      return url?.external ? linkHtml(url, title, this.parser.parseInline(tokens)) : false;
    },
  },
});

/** Parse markdown to HTML, raw HTML included: the chat trusts the model in the user's own chat. */
export function parseMarkdown(text: string): string {
  return marked.parse(text, { async: false });
}

// ---------------------------------------------------------------------------
// Text from outside (an extension's: a GitHub issue)
// ---------------------------------------------------------------------------

const untrusted = new Marked(OPTIONS, codeBlocks, {
  renderer: {
    html: () => "",
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const url = checkUrl(href, ["http:", "https:", "mailto:"]);
      return url ? linkHtml(url, title, text) : text;
    },
    image({ href, title, text }) {
      const url = checkUrl(href, ["http:", "https:"]);
      if (!url) return escapeHtml(text);
      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${url.href}" alt="${escapeHtml(text)}"${titleAttribute}>`;
    },
  },
});

/**
 * Parse markdown from outside the user's own chat. Raw HTML is left out, tags and all (the Markdown between them
 * stays); links keep only http, https and mailto URLs or relative ones, and images http and https ones (others
 * become their text); a link that leaves the page opens in a new tab.
 */
export function parseUntrustedMarkdown(text: string): string {
  return untrusted.parse(text, { async: false });
}

// ---------------------------------------------------------------------------
// After the HTML is on the page
// ---------------------------------------------------------------------------

let mermaidReady: Promise<typeof import("mermaid")["default"]> | null = null;

async function ensureMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((m) => {
      // Mermaid's default security level, "strict", escapes labels' HTML and allows no click handlers.
      m.default.initialize({ startOnLoad: false, theme: "dark" });
      return m.default;
    });
  }
  return mermaidReady;
}

/** Highlights the code blocks and draws the Mermaid diagrams in `root` that are not done yet. */
export async function renderCodeAndDiagrams(root: ParentNode): Promise<void> {
  highlightCodeBlocks(root);
  await renderMermaid(root);
}

function highlightCodeBlocks(root: ParentNode) {
  const codeEls = root.querySelectorAll<HTMLElement>("pre code[data-lang]");
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

async function renderMermaid(root: ParentNode) {
  const unrendered = Array.from(root.querySelectorAll<HTMLElement>("div.mermaid")).filter(
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
