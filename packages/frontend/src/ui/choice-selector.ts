/**
 * An inline, borderless choice: its current value as text, which opens a `popover-menu` with the
 * `content` it is given (a `choice-menu`, or a panel of its own). `prompt` marks a choice still to make.
 */

import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { chevronDownIcon } from "./icons.js";
import "./popover-menu.js";
import type { PopoverAnchor } from "./popover-menu.js";

@customElement("choice-selector")
export class ChoiceSelector extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) label = "";
  @property({ attribute: false }) icon: TemplateResult | null = null;
  @property({ type: Boolean }) prompt = false;
  /** Classes of the popover's panel, such as its width. */
  @property({ type: String }) panelClass = "";
  @property({ type: String }) anchor: PopoverAnchor = "left";
  /** The popover's content, rendered only while it is open. */
  @property({ attribute: false }) content: (() => TemplateResult) | null = null;

  override render() {
    return html`
      <popover-menu
        panelClass=${this.panelClass}
        anchor=${this.anchor}
        .content=${this.content}
        .triggerTemplate=${html`
          <span
            class="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-zinc-800 ${this.prompt
              ? "text-blue-300 hover:text-blue-200"
              : "text-zinc-400 hover:text-zinc-100"}"
          >
            ${this.icon ?? ""}
            <span class="truncate">${this.label}</span>
            ${chevronDownIcon("shrink-0 opacity-60", 12)}
          </span>
        `}
      ></popover-menu>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "choice-selector": ChoiceSelector;
  }
}
