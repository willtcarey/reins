/**
 * Popover Menu
 *
 * A generic three-dot overflow menu. Handles open/close toggle and
 * click-outside dismissal.
 *
 * Menu content is provided via the `content` property — a function
 * returning a Lit TemplateResult. This avoids light DOM / slot issues
 * since the component uses light DOM for Tailwind compatibility.
 *
 * The menu auto-closes when a click lands inside the panel.
 */

import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("popover-menu")
export class PopoverMenu extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Extra classes applied to the trigger button. */
  @property({ type: String })
  triggerClass = "";

  /** Render function for menu content. Called only when the menu is open. */
  @property({ attribute: false })
  content: (() => TemplateResult) | null = null;

  @state() private open = false;

  private _onDocClick = (e: MouseEvent) => {
    if (!this.open) return;
    if (!this.contains(e.target as Node)) {
      this.open = false;
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("click", this._onDocClick, true);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("click", this._onDocClick, true);
  }

  close() {
    this.open = false;
  }

  private toggle(e: Event) {
    e.stopPropagation();
    this.open = !this.open;
  }

  private onPanelClick() {
    this.open = false;
  }

  override render() {
    return html`
      <div class="relative shrink-0">
        <button
          class="px-2 py-2.5 text-zinc-600 hover:text-zinc-300 transition-all cursor-pointer
            ${this.open ? "!opacity-100 text-zinc-300" : ""} ${this.triggerClass}"
          title="Actions"
          @click=${this.toggle}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
        ${this.open && this.content ? html`
          <div
            class="absolute right-0 top-full z-40 mt-0.5 w-36 bg-zinc-800 border border-zinc-600 rounded-md shadow-xl overflow-hidden"
            @click=${this.onPanelClick}
          >
            ${this.content()}
          </div>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "popover-menu": PopoverMenu;
  }
}
