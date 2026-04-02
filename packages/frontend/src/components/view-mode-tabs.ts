/**
 * View Mode Tabs — reusable tab bar for toggling between views.
 *
 * Renders a horizontal tab bar with optional SVG icons and labels.
 * Emits a `tab-change` CustomEvent with `{ detail: number }` when
 * the user clicks a tab.
 *
 * Usage:
 *   <view-mode-tabs
 *     .tabs=${[{ label: "Code", icon: svg`...` }, { label: "Preview", icon: svg`...` }]}
 *     .activeIndex=${0}
 *     @tab-change=${(e) => this._activeTab = e.detail}
 *   ></view-mode-tabs>
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { TemplateResult } from "lit";

export interface TabDef {
  label: string;
  icon?: TemplateResult;
}

@customElement("view-mode-tabs")
export class ViewModeTabs extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) tabs: TabDef[] = [];
  @property({ type: Number }) activeIndex = 0;

  private _onTabClick(index: number) {
    if (index === this.activeIndex) return;
    this.dispatchEvent(
      new CustomEvent("tab-change", { detail: index, bubbles: true, composed: true }),
    );
  }

  override render() {
    return html`
      <div class="flex items-center border-b border-zinc-700 bg-zinc-800/50" @click=${(e: Event) => e.stopPropagation()}>
        ${this.tabs.map(
          (tab, i) => html`
            <button
              class="px-3 py-1.5 text-xs cursor-pointer transition-colors ${
                i === this.activeIndex
                  ? "text-zinc-200 border-b-2 border-blue-400"
                  : "text-zinc-500 hover:text-zinc-300 border-b-2 border-transparent"
              }"
              @click=${() => this._onTabClick(i)}
            >
              <span class="flex items-center gap-1">${tab.icon ?? ""}${tab.label}</span>
            </button>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-mode-tabs": ViewModeTabs;
  }
}
