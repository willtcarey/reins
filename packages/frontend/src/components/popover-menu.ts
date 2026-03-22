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
import { styleMap } from "lit/directives/style-map.js";

@customElement("popover-menu")
export class PopoverMenu extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Extra classes applied to the trigger button. */
  @property({ type: String })
  triggerClass = "";

  /** Extra classes applied to the panel. Overrides default width. */
  @property({ type: String })
  panelClass = "";

  /** Render function for menu content. Called only when the menu is open. */
  @property({ attribute: false })
  content: (() => TemplateResult) | null = null;

  /** Optional custom trigger template. When set, replaces the default three-dot icon. */
  @property({ attribute: false })
  triggerTemplate: TemplateResult | null = null;

  /**
   * Controls where the panel appears relative to the trigger.
   * - "right" (default): right edge aligned, opens downward
   * - "left": left edge aligned, opens downward
   * - "right-start": opens to the right of the trigger, top-aligned
   * - "left-start": opens to the left of the trigger, top-aligned
   */
  @property({ type: String })
  anchor: "right" | "left" | "right-start" | "left-start" = "right";

  @state() private open = false;
  @state() private panelStyle: Record<string, string> = {};

  private _onDocClick = (e: MouseEvent) => {
    if (!this.open) return;
    if (!this.contains(e.target as Node)) {
      this.open = false;
    }
  };

  private _onScroll = () => {
    if (this.open) this.open = false;
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("click", this._onDocClick, true);
    document.addEventListener("scroll", this._onScroll, true);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("click", this._onDocClick, true);
    document.removeEventListener("scroll", this._onScroll, true);
  }

  close() {
    this.open = false;
  }

  private toggle(e: Event) {
    e.stopPropagation();
    if (!this.open) {
      this.updatePanelPosition();
    }
    this.open = !this.open;
  }

  /** Compute fixed position for the panel based on trigger's viewport rect. */
  private updatePanelPosition() {
    const trigger = this.renderRoot.querySelector("button") ?? this;
    const rect = trigger.getBoundingClientRect();
    const gap = 2;

    let style: Record<string, string>;
    switch (this.anchor) {
      case "left":
        style = { top: `${rect.bottom + gap}px`, left: `${rect.left}px` };
        break;
      case "right-start":
        style = { top: `${rect.top}px`, left: `${rect.right + gap}px` };
        break;
      case "left-start":
        style = { top: `${rect.top}px`, right: `${window.innerWidth - rect.left + gap}px` };
        break;
      case "right":
      default:
        style = { top: `${rect.bottom + gap}px`, right: `${window.innerWidth - rect.right}px` };
        break;
    }
    this.panelStyle = style;
  }

  private onPanelClick() {
    this.open = false;
  }

  override render() {
    return html`
      <div class="shrink-0">
        <button
          class="${this.triggerTemplate
            ? `cursor-pointer ${this.triggerClass}`
            : `px-2 py-2.5 text-zinc-600 hover:text-zinc-300 transition-all cursor-pointer ${this.open ? "!opacity-100 text-zinc-300" : ""} ${this.triggerClass}`}"
          title="${this.triggerTemplate ? "" : "Actions"}"
          @click=${this.toggle}
        >
          ${this.triggerTemplate ?? html`
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          `}
        </button>
        ${this.open && this.content ? html`
          <div
            class="fixed z-50 ${this.panelClass || "w-36"} bg-zinc-800 border border-zinc-600 rounded-md shadow-xl overflow-hidden"
            style=${styleMap(this.panelStyle)}
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
