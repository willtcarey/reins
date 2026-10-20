import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { InspectorTab } from "../../models/inspector.js";
import { closeIcon } from "../../ui/icons.js";
import { inspectorTabCloseEvent, inspectorTabFocusEvent } from "../events.js";
import { renderView, viewDescription, viewIcon, viewTitle, type ViewContext } from "./views.js";

/**
 * The Inspector: a strip of tabs, each showing a view. Every tab stays rendered while hidden, so a
 * file keeps its place and mode while another tab is shown.
 */
@customElement("workspace-inspector")
export class WorkspaceInspector extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) tabs: readonly InspectorTab[] = [];
  @property({ attribute: false }) activeKey = "";
  @property({ attribute: false }) context: ViewContext | null = null;

  private renderTab(tab: InspectorTab) {
    const active = tab.key === this.activeKey;
    const title = viewTitle(tab.view);
    const closable = tab.closable;
    return html`
      <div
        class="group flex max-w-[12rem] shrink-0 items-center border-r border-zinc-800 ${active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"}"
        @auxclick=${(event: MouseEvent) => { if (event.button === 1 && closable) this.dispatchEvent(inspectorTabCloseEvent(tab.key)); }}
      >
        <button
          role="tab"
          aria-selected=${active ? "true" : "false"}
          title=${viewDescription(tab.view)}
          class="flex h-full min-w-0 cursor-pointer items-center gap-1.5 py-1.5 text-xs ${closable ? "pl-2.5 pr-1" : "px-2.5"}"
          @click=${() => this.dispatchEvent(inspectorTabFocusEvent(tab.key))}
        >${viewIcon(tab.view)}<span class="truncate">${title}</span></button>
        ${closable ? html`
          <button
            class="mr-1 shrink-0 cursor-pointer rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
            title="Close"
            @click=${() => this.dispatchEvent(inspectorTabCloseEvent(tab.key))}
          >${closeIcon("", 12)}<span class="sr-only">Close ${title}</span></button>
        ` : nothing}
      </div>
    `;
  }

  override render() {
    const context = this.context;
    if (!context) return nothing;
    return html`
      <div class="flex h-full min-h-0 min-w-0 flex-col">
        <div role="tablist" aria-label="Inspector" data-swipe-surface class="flex h-[50px] shrink-0 items-stretch overflow-x-auto [scrollbar-width:none] border-b border-zinc-800 bg-zinc-900/80">
          ${this.tabs.map((tab) => this.renderTab(tab))}
        </div>
        <div class="relative min-h-0 flex-1">
          ${repeat(this.tabs, (tab) => tab.key, (tab) => html`
            <div role="tabpanel" aria-label=${viewDescription(tab.view)} class="absolute inset-0 flex min-h-0 flex-col" ?hidden=${tab.key !== this.activeKey}>
              ${renderView(tab.view, tab, context)}
            </div>
          `)}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "workspace-inspector": WorkspaceInspector;
  }
}
