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

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import type { TemplateResult } from "lit";
import { computePosition } from "./position.js";
import { navigationFolderIcon, searchIcon, settingsIcon } from "./icons.js";

type IconName = "search" | "settings" | "folder";

const icons: Record<IconName, (className: string, size: number) => TemplateResult> = {
  search: searchIcon,
  settings: settingsIcon,
  folder: navigationFolderIcon,
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
    const iconContent = icons[this.icon]("", this.size);
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
        ${iconContent}
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
