/**
 * `<reins-markdown>`: Markdown for extensions, drawn as the chat draws it (the app's renderer,
 * markdown-rendering.ts), from text that may come from outside, so raw HTML is left out and links are checked.
 * Its contract is `@reins/ui`'s (packages/ui/ui.d.ts). The app defines it in the page's global registry at startup;
 * `define(registry)` of `@reins/ui` gives a scoped registry a subclass of it (docs/dev/extension-loading.md
 * *Provided libraries*).
 */

import { LitElement, html } from "lit";
import { property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { ReinsMarkdownElement } from "@reins/ui";
import { MARKDOWN_CLASSES, parseUntrustedMarkdown, renderCodeAndDiagrams } from "./markdown-rendering.js";

export class ReinsMarkdown extends LitElement implements ReinsMarkdownElement {
  // A removed attribute is no text.
  @property({ converter: { fromAttribute: (value: string | null) => value ?? "" } })
  text = "";

  override createRenderRoot() {
    return this;
  }

  override render() {
    try {
      return html`<div class=${MARKDOWN_CLASSES}>${unsafeHTML(parseUntrustedMarkdown(this.text ?? ""))}</div>`;
    } catch {
      return html`<pre class="whitespace-pre-wrap text-sm">${this.text}</pre>`;
    }
  }

  override async updated() {
    await renderCodeAndDiagrams(this);
  }
}

if (!customElements.get("reins-markdown")) customElements.define("reins-markdown", ReinsMarkdown);
