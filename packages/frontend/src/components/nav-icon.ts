/**
 * Nav Icon — reusable toolbar icon button with animated tooltip.
 *
 * Renders a styled button with a named SVG icon. Used for sidebar
 * and tab-bar navigation actions (session search, settings, file browser).
 *
 * The tooltip is fixed-positioned so it isn't clipped by ancestor
 * overflow:hidden (e.g. the collapsed sidebar rail).
 *
 * Usage:
 *   <nav-icon icon="search" label="Search sessions (Cmd+K)" @click=${handler}></nav-icon>
 */

import { LitElement, html, svg, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import type { SVGTemplateResult } from "lit";
import { computePosition } from "./position.js";

type IconName = "search" | "settings" | "folder";

const icons: Record<IconName, SVGTemplateResult> = {
  search: svg`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`,
  settings: svg`<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
  folder: svg`<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
};

@customElement("nav-icon")
export class NavIcon extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Which icon to render. */
  @property() icon: IconName = "search";

  /** Tooltip text for the button. */
  @property() label = "";

  /** Icon width/height in px. */
  @property({ type: Number }) size = 14;

  /** Compact mode — smaller padding, more subdued color. Used in the collapsed sidebar rail. */
  @property({ type: Boolean }) compact = false;

  @state() private _tooltipVisible = false;
  private _tooltipStyle: Record<string, string> = {};

  private _show = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    this._computePosition();
    this._tooltipVisible = true;
  };

  private _hide = () => {
    this._tooltipVisible = false;
  };

  private _computePosition() {
    const button = this.querySelector("button");
    const tip = this.querySelector<HTMLElement>(".nav-tooltip");
    if (!button || !tip) return;

    const pos = computePosition({
      anchor: button.getBoundingClientRect(),
      width: tip.offsetWidth,
      height: tip.offsetHeight,
      placement: this.compact ? "right" : "bottom",
      gap: 6,
    });
    this._tooltipStyle = { top: `${pos.top}px`, left: `${pos.left}px` };
  }

  override render() {
    const iconContent = icons[this.icon];
    if (!iconContent) return nothing;

    const buttonClass = this.compact
      ? "p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/70 cursor-pointer transition-colors"
      : "p-2 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/70 cursor-pointer transition-colors shrink-0";

    return html`
      <button class=${buttonClass} aria-label=${this.label}
        @pointerenter=${this._show}
        @pointerleave=${this._hide}
        @click=${this._hide}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width=${this.size} height=${this.size}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round">${iconContent}</svg>
      </button>
      ${this.label ? html`
        <div
          class="nav-tooltip fixed z-[var(--layer-overlay)] px-2 py-1 text-xs font-medium text-zinc-200 bg-zinc-700 rounded shadow-lg whitespace-nowrap pointer-events-none transition-[opacity,transform] duration-150 ${this._tooltipVisible ? "opacity-100 scale-100" : "opacity-0 scale-95"}"
          style=${styleMap(this._tooltipStyle)}
        >${this.label}</div>
      ` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "nav-icon": NavIcon;
  }
}
