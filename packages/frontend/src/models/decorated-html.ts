/**
 * How the app applies message decorators to rendered text (docs/dev/reins-sdk.md *Messages*):
 * Markdown through marked's tokens, user messages' plain text through segments. Each decorated piece
 * renders as a `<reins-view-mount>` around its original text, which `InlineViewsController` gives its
 * view once it is on the page.
 */

import { marked, type MarkedExtension, type Token, type Tokens } from "marked";
import type { InlinePiece, BoundDecorators } from "../sdk-host/decorators.js";

/** Decorated HTML: each view mount's `data-piece` is the index of its piece in `pieces`. */
export interface DecoratedHtml {
  html: string;
  pieces: readonly InlinePiece[];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function viewMount(index: number, content: string): string {
  return `<reins-view-mount data-piece="${index}">${content}</reins-view-mount>`;
}

const decorationExtension: MarkedExtension = {
  extensions: [{
    name: "decoration",
    renderer(token) {
      const content = token.code
        ? this.parser.renderer.codespan({ type: "codespan", raw: token.raw, text: token.text })
        : this.parser.renderer.text({ type: "text", raw: token.raw, text: token.text });
      return viewMount(token.index, content);
    },
  }],
};

marked.use(decorationExtension);

/**
 * Replaces what decorators find in prose and inline code with decoration tokens, collecting their
 * pieces. Code blocks, HTML, links and images keep their own semantics and are left as they are.
 */
function decorateTokens(tokens: Token[], decorators: BoundDecorators, pieces: InlinePiece[]): Token[] {
  const decorationToken = (piece: InlinePiece): Tokens.Generic => {
    pieces.push(piece);
    const { text, code } = piece.context;
    return { type: "decoration", raw: text, text, code, index: pieces.length - 1 };
  };
  return tokens.flatMap((token): Token[] => {
    switch (token.type) {
      case "code":
      case "html":
      case "link":
      case "image":
        return [token];
      case "codespan": {
        const piece = decorators.code(token.text);
        return piece ? [decorationToken(piece)] : [token];
      }
      case "text": {
        if (token.tokens) {
          token.tokens = decorateTokens(token.tokens, decorators, pieces);
          return [token];
        }
        if (token.escaped) return [token];
        return decorators.segments(token.text).map((segment): Token => (typeof segment === "string"
          ? { type: "text", raw: segment, text: segment }
          : decorationToken(segment)));
      }
      case "table":
        for (const cell of [...token.header, ...token.rows.flat()]) cell.tokens = decorateTokens(cell.tokens, decorators, pieces);
        return [token];
      case "list":
        for (const item of token.items) item.tokens = decorateTokens(item.tokens, decorators, pieces);
        return [token];
      default:
        if ("tokens" in token && token.tokens) token.tokens = decorateTokens(token.tokens, decorators, pieces);
        return [token];
    }
  });
}

/** Markdown as HTML, with what the decorators find in view mounts. */
export function decoratedMarkdown(text: string, decorators: BoundDecorators): DecoratedHtml {
  const pieces: InlinePiece[] = [];
  const html = marked.parser(decorateTokens(marked.lexer(text), decorators, pieces));
  return { html, pieces };
}

/** A user message's text (not Markdown) as HTML, with what the decorators find in view mounts. */
export function decoratedPlainText(text: string, decorators: BoundDecorators): DecoratedHtml {
  const pieces: InlinePiece[] = [];
  const html = decorators.plainText(text).map((segment) => {
    if (typeof segment === "string") return escapeHtml(segment);
    pieces.push(segment);
    return viewMount(pieces.length - 1, escapeHtml(segment.context.text));
  }).join("");
  return { html, pieces };
}
