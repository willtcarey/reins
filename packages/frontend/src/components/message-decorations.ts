/**
 * How the host applies message decorators to rendered text (docs/dev/reins-sdk.md *Messages*):
 * Markdown through marked's tokens, user messages' plain text through segments. Decorations render
 * as buttons around their original text, which open their view through the decorations' host.
 */

import { html, type TemplateResult } from "lit";
import { marked, type MarkedExtension, type Token, type Tokens } from "marked";
import { parseView, type Decoration, type View } from "../reins-sdk/contract.js";
import type { MessageDecorations } from "../reins-sdk/decorations.js";

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const decorationExtension: MarkedExtension = {
  extensions: [{
    name: "decoration",
    renderer(token) {
      const decoration: Decoration = token.decoration;
      const content = token.code
        ? this.parser.renderer.codespan({ type: "codespan", raw: token.raw, text: token.text })
        : this.parser.renderer.text({ type: "text", raw: token.raw, text: token.text });
      return `<button type="button" class="message-decoration" data-view="${escapeAttribute(JSON.stringify(decoration.view))}" title="${escapeAttribute(decoration.label)}">${content}</button>`;
    },
  }],
};

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

/** Markdown as HTML, with what the decorators find as buttons. */
export function decoratedMarkdown(text: string, decorations: MessageDecorations): string {
  return marked.parser(decorateTokens(marked.lexer(text), decorations));
}

function viewOfTarget(target: unknown): View | null {
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

/** Opens the view of a decoration a click in decorated Markdown landed on; false for any other click. */
export function activateDecoration(event: Event, decorations: MessageDecorations | null): boolean {
  const view = decorations ? viewOfTarget(event.target) : null;
  if (!decorations || !view) return false;
  event.preventDefault();
  event.stopPropagation();
  decorations.open(view);
  return true;
}

/** A user message's text (not Markdown), with what the decorators find as buttons. */
export function decoratedPlainText(text: string, decorations: MessageDecorations | null): string | TemplateResult[] {
  if (!decorations) return text;
  return decorations.plainText(text).map((segment) => (typeof segment === "string"
    ? html`${segment}`
    : html`<button type="button" class="message-decoration" title=${segment.label} @click=${(event: Event) => {
      event.stopPropagation();
      decorations.open(segment.view);
    }}>${segment.text}</button>`));
}
