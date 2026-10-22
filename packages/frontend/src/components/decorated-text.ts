/**
 * Plain text (a user message's, which is not Markdown) with message decorators applied. Light DOM,
 * so it takes its container's whitespace and colors.
 */

import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { MessageDecorations } from "../reins-sdk/decorations.js";
import { InlineViews, decoratedPlainText, type DecoratedHtml } from "./message-decorations.js";

@customElement("decorated-text")
export class DecoratedText extends LitElement {
  @property({ attribute: false }) text = "";
  @property({ attribute: false }) decorations: MessageDecorations | null = null;

  private parsed: { text: string; decorations: MessageDecorations; html: DecoratedHtml } | null = null;
  private inlineViews = new InlineViews(this);

  override createRenderRoot() {
    return this;
  }

  override render() {
    const { text, decorations } = this;
    if (!decorations) return text;
    if (this.parsed?.text !== text || this.parsed.decorations !== decorations) {
      this.parsed = { text, decorations, html: decoratedPlainText(text, decorations) };
    }
    return this.inlineViews.render(this.parsed.html);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "decorated-text": DecoratedText;
  }
}
