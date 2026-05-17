/**
 * Branch Indicator
 *
 * Displays the currently checked-out git branch for the project,
 * sourced from the diff store's polling data. Shows the same branch
 * regardless of whether the active session is a task or scratch session —
 * it always reflects the actual working tree state.
 */

import { LitElement, html, nothing } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { customElement, property, state } from "lit/decorators.js";
import { computePosition } from "./position.js";

@customElement("branch-indicator")
export class BranchIndicator extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** The repo's current checked-out branch, provided by the diff store. */
  @property({ type: String }) currentBranch: string | null = null;

  @state() private _tooltipVisible = false;
  @state() private _tooltipStyle: Record<string, string> = {};
  private _pinned = false;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this._onDocumentPointerDown, true);
    document.addEventListener("scroll", this._onScroll, true);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("pointerdown", this._onDocumentPointerDown, true);
    document.removeEventListener("scroll", this._onScroll, true);
  }

  private _onDocumentPointerDown = (e: PointerEvent) => {
    if (!this._pinned) return;
    if (e.target instanceof Node && this.contains(e.target)) return;
    this._closeTooltip();
  };

  private _onScroll = () => {
    if (this._tooltipVisible) this._closeTooltip();
  };

  private _showOnPointer = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    this._showTooltip();
  };

  private _showTooltip = () => {
    this._computeTooltipPosition();
    this._tooltipVisible = true;
  };

  private _hideTooltip = () => {
    if (this._pinned) return;
    this._tooltipVisible = false;
  };

  private _closeTooltip() {
    this._pinned = false;
    this._tooltipVisible = false;
  }

  private _togglePinned(e: Event) {
    e.stopPropagation();
    if (this._pinned) {
      this._closeTooltip();
      return;
    }

    this._pinned = true;
    this._showTooltip();
  }

  private _computeTooltipPosition() {
    const button = this.querySelector("button");
    const tooltip = this.querySelector<HTMLElement>(".branch-tooltip");
    if (!button || !tooltip) return;

    const pos = computePosition({
      anchor: button.getBoundingClientRect(),
      width: tooltip.offsetWidth,
      height: tooltip.offsetHeight,
      placement: "bottom-end",
      gap: 6,
      viewportPad: 8,
    });
    this._tooltipStyle = { top: `${pos.top}px`, left: `${pos.left}px` };
  }

  override render() {
    if (!this.currentBranch) return nothing;

    const tooltipId = "branch-indicator-tooltip";

    return html`
      <button
        type="button"
        class="flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-zinc-800/70 bg-zinc-950/30 px-2 text-sm text-zinc-500 hover:border-zinc-700 hover:bg-zinc-900/70 hover:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-zinc-600 cursor-pointer transition-colors"
        aria-label=${`Current branch: ${this.currentBranch}`}
        aria-expanded=${this._tooltipVisible}
        aria-describedby=${this._tooltipVisible ? tooltipId : nothing}
        @pointerenter=${this._showOnPointer}
        @pointerleave=${this._hideTooltip}
        @focus=${this._showTooltip}
        @blur=${this._hideTooltip}
        @click=${this._togglePinned}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             class="shrink-0 text-zinc-500">
          <line x1="6" y1="3" x2="6" y2="15"></line>
          <circle cx="18" cy="6" r="3"></circle>
          <circle cx="6" cy="18" r="3"></circle>
          <path d="M18 9a9 9 0 0 1-9 9"></path>
        </svg>
        <span class="min-w-0 truncate font-mono text-zinc-400">${this.currentBranch}</span>
      </button>
      <div
        id=${tooltipId}
        role="tooltip"
        class="branch-tooltip fixed z-[var(--layer-overlay)] max-w-[calc(100vw-1rem)] rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs font-mono text-zinc-100 shadow-xl whitespace-normal break-all pointer-events-none transition-[opacity,transform] duration-150 ${this._tooltipVisible ? "opacity-100 scale-100" : "opacity-0 scale-95"}"
        style=${styleMap(this._tooltipStyle)}
      >${this.currentBranch}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "branch-indicator": BranchIndicator;
  }
}
