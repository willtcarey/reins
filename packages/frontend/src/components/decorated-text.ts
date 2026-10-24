/**
 * Plain text (a user message's, which is not Markdown) with message decorators applied. Light DOM,
 * so it takes its container's whitespace and colors.
 */

import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { InlineViewsController } from "../controllers/inline-views-controller.js";
import { decoratedPlainText, type DecoratedHtml } from "../models/decorated-html.js";
import type { BoundDecorators } from "../sdk-host/decorators.js";
import "./view-mount.js";

@customElement("decorated-text")
export class DecoratedText extends LitElement {
  @property({ attribute: false }) text = "";
  @property({ attribute: false }) decorators: BoundDecorators | null = null;

  private parsed: { text: string; decorators: BoundDecorators; html: DecoratedHtml } | null = null;
  private inlineViews = new InlineViewsController(this);

  override createRenderRoot() {
    return this;
  }

  override render() {
    const { text, decorators } = this;
    if (!decorators) return text;
    if (this.parsed?.text !== text || this.parsed.decorators !== decorators) {
      this.parsed = { text, decorators, html: decoratedPlainText(text, decorators) };
    }
    return this.inlineViews.render(this.parsed.html);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "decorated-text": DecoratedText;
  }
}
