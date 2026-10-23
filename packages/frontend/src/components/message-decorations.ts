/**
 * How the app applies message decorators to rendered text (docs/dev/reins-sdk.md *Messages*):
 * Markdown through marked's tokens, user messages' plain text through segments. Each decorated piece
 * renders as a `<reins-view-mount>` around its original text, which `InlineViews` gives its view once
 * it is on the page.
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked, type MarkedExtension, type Token, type Tokens } from "marked";
import type { InlinePiece, MessageDecorations } from "../reins-sdk/decorations.js";
import type { ViewMount } from "./view-mount.js";
import "./view-mount.js";

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
function decorateTokens(tokens: Token[], decorations: MessageDecorations, pieces: InlinePiece[]): Token[] {
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
        const piece = decorations.code(token.text);
        return piece ? [decorationToken(piece)] : [token];
      }
      case "text": {
        if (token.tokens) {
          token.tokens = decorateTokens(token.tokens, decorations, pieces);
          return [token];
        }
        if (token.escaped) return [token];
        return decorations.segments(token.text).map((segment): Token => (typeof segment === "string"
          ? { type: "text", raw: segment, text: segment }
          : decorationToken(segment)));
      }
      case "table":
        for (const cell of [...token.header, ...token.rows.flat()]) cell.tokens = decorateTokens(cell.tokens, decorations, pieces);
        return [token];
      case "list":
        for (const item of token.items) item.tokens = decorateTokens(item.tokens, decorations, pieces);
        return [token];
      default:
        if ("tokens" in token && token.tokens) token.tokens = decorateTokens(token.tokens, decorations, pieces);
        return [token];
    }
  });
}

/** Markdown as HTML, with what the decorators find in view mounts. */
export function decoratedMarkdown(text: string, decorations: MessageDecorations): DecoratedHtml {
  const pieces: InlinePiece[] = [];
  const html = marked.parser(decorateTokens(marked.lexer(text), decorations, pieces));
  return { html, pieces };
}

/** A user message's text (not Markdown) as HTML, with what the decorators find in view mounts. */
export function decoratedPlainText(text: string, decorations: MessageDecorations): DecoratedHtml {
  const pieces: InlinePiece[] = [];
  const html = decorations.plainText(text).map((segment) => {
    if (typeof segment === "string") return escapeHtml(segment);
    pieces.push(segment);
    return viewMount(pieces.length - 1, escapeHtml(segment.context.text));
  }).join("");
  return { html, pieces };
}

/** What `InlineViews` needs of its element: the view mounts its rendered HTML put on the page. */
export interface InlineViewsHost extends ReactiveControllerHost {
  querySelectorAll(selectors: "reins-view-mount"): Iterable<ViewMount>;
}

/**
 * Renders decorated HTML for a light-DOM element and gives each of its view mounts its piece after
 * the update that rendered new HTML. The view mounts mount, update and dispose themselves, also when
 * the element leaves the page and comes back.
 */
export class InlineViews implements ReactiveController {
  private rendering: DecoratedHtml | null = null;
  private given: DecoratedHtml | null = null;

  constructor(private readonly host: InlineViewsHost) {
    host.addController(this);
  }

  /** The decorated HTML as a template part; call it from the host's render. */
  render(rendered: DecoratedHtml) {
    this.rendering = rendered;
    return unsafeHTML(rendered.html);
  }

  hostUpdate(): void {
    this.rendering = null;
  }

  hostUpdated(): void {
    // An update that rendered none replaced the view mounts, so the same HTML later is given again.
    const rendered = this.rendering;
    if (rendered === this.given) return;
    this.given = rendered;
    if (!rendered) return;
    for (const element of this.host.querySelectorAll("reins-view-mount")) {
      const piece = rendered.pieces[Number(element.getAttribute("data-piece"))];
      if (!piece) continue;
      element.presentation = piece.presentation;
      element.view = piece.view;
      element.context = piece.context;
    }
  }
}
