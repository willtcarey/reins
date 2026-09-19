/**
 * Popover Menu
 *
 * A generic anchored popover. Handles open/close toggling, viewport-aware
 * positioning, and click-outside dismissal.
 *
 * Menu content is provided via the `content` property — a function returning a
 * Lit TemplateResult. This avoids light DOM / slot issues since the component
 * uses light DOM for Tailwind compatibility.
 *
 * Set `closeOnPanelClick` for action-menu usage where choosing an item should
 * dismiss the panel. Form-like popovers should keep the default open behavior.
 */

import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { moreVerticalIcon } from "./icons.js";
import { computePosition, type Placement } from "./position.js";

export type PopoverAnchor = "right" | "left" | "right-start" | "left-start" | "right-end" | "left-end";

const placements: Record<PopoverAnchor, Placement> = {
  right: "bottom-end",
  left: "bottom-start",
  "right-start": "right-start",
  "left-start": "left-start",
  "right-end": "top-end",
  "left-end": "top-start",
};

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

  /** Whether clicks inside the panel should close the popover. */
  @property({ type: Boolean, attribute: "close-on-panel-click" })
  closeOnPanelClick = false;

  /**
   * Controls where the panel appears relative to the trigger.
   * - "right" (default): right edge aligned, opens downward
   * - "left": left edge aligned, opens downward
   * - "right-start": opens to the right of the trigger, top-aligned
   * - "left-start": opens to the left of the trigger, top-aligned
   * - "right-end": right edge aligned, opens upward
   * - "left-end": left edge aligned, opens upward
   */
  @property({ type: String })
  anchor: PopoverAnchor = "right";

  @state() private open = false;

  private panelResizeObserver: ResizeObserver | null = null;
  private observedPanel: HTMLElement | null = null;

  private _onDocClick = (event: MouseEvent) => {
    if (!this.open) return;
    if (!event.composedPath().includes(this)) {
      event.preventDefault();
      event.stopPropagation();
      this.open = false;
    }
  };

  private _onScroll = (event: Event) => {
    if (!this.open || event.composedPath().includes(this)) return;
    this.open = false;
  };

  private _onResize = () => {
    if (this.open) this.updatePanelPosition();
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("click", this._onDocClick, true);
    document.addEventListener("scroll", this._onScroll, true);
    window.addEventListener("resize", this._onResize);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("click", this._onDocClick, true);
    document.removeEventListener("scroll", this._onScroll, true);
    window.removeEventListener("resize", this._onResize);
    this.stopObservingPanel();
  }

  close() {
    this.open = false;
  }

  private toggle(event: Event) {
    event.stopPropagation();
    this.open = !this.open;
  }

  private updatePanelPosition(panel = this.renderRoot.querySelector<HTMLElement>("[data-role=popover-panel]")) {
    const trigger = this.renderRoot.querySelector<HTMLElement>("button");
    if (!trigger || !panel || typeof trigger.getBoundingClientRect !== "function") return;

    const position = computePosition({
      anchor: trigger.getBoundingClientRect(),
      width: panel.offsetWidth,
      height: panel.offsetHeight,
      placement: placements[this.anchor],
      gap: 2,
      viewportPad: 4,
    });
    const style = { top: `${position.top}px`, left: `${position.left}px` };

    Object.assign(panel.style, style);
  }

  private onPanelClick() {
    if (this.closeOnPanelClick) {
      this.open = false;
    }
  }

  private observePanel(panel: HTMLElement) {
    if (this.observedPanel === panel || typeof ResizeObserver === "undefined") return;

    this.stopObservingPanel();
    this.observedPanel = panel;
    this.panelResizeObserver = new ResizeObserver(() => {
      if (this.open) this.updatePanelPosition(panel);
    });
    this.panelResizeObserver.observe(panel);
  }

  private stopObservingPanel() {
    this.panelResizeObserver?.disconnect();
    this.panelResizeObserver = null;
    this.observedPanel = null;
  }

  override updated() {
    const panel = this.renderRoot.querySelector<HTMLElement>("[data-role=popover-panel]");
    if (!panel) {
      this.stopObservingPanel();
      return;
    }

    if (typeof panel.showPopover === "function" && !panel.matches(":popover-open")) {
      panel.showPopover();
    }
    this.updatePanelPosition(panel);
    this.observePanel(panel);
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
          ${this.triggerTemplate ?? moreVerticalIcon()}
        </button>
        ${this.open && this.content ? html`
          <div
            data-role="popover-panel"
            popover="manual"
            class="fixed inset-auto m-0 max-w-[calc(100vw-0.5rem)] max-h-[calc(100dvh-1rem)] p-0 z-[var(--layer-overlay)] ${this.panelClass || "w-36"} bg-zinc-800 border border-zinc-600 rounded-md shadow-xl overflow-x-hidden overflow-y-auto"
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
