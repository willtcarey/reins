import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { openMainViewEvent, paneSelectEvent, reloadRequestEvent } from "./events.js";
import type { PaneContext, View } from "@reins/sdk";
import type { Mountable } from "./view-mount.js";
import "./view-mount.js";
import { menuIcon } from "../ui/icons.js";
import "../ui/popover-menu.js";
import { statusDot } from "../ui/status-dot.js";

/** One of the main area's tabs (`ViewRenderer.tabOf`): its view and its title. */
export interface MainTab {
  readonly view: View;
  readonly title: string;
}

/**
 * The host's toolbar over the main area: the sidebar button on a phone, the main area's tabs, the shown view's own
 * toolbar (or its title), then the connection status and the menu.
 */
@customElement("app-main-toolbar")
export class AppMainToolbar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) isStandalone = false;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean, attribute: "show-sidebar-button" }) showSidebarButton = false;
  /** The main area's tabs; none (or one) while it shows a view alone. */
  @property({ attribute: false }) tabs: readonly MainTab[] = [];
  /** The tab this toolbar is over: on a phone each tab's page has a toolbar, which marks its own. */
  @property({ type: Number }) activeTab = 0;
  /** The title of the view shown, without tabs or a toolbar of its own (a phone's header shows it). */
  @property({ attribute: false }) pageTitle: string | null = null;
  /** The shown view's own toolbar (`PanePresentation.toolbar`). */
  @property({ attribute: false }) viewToolbar: { presentation: Mountable; view: View; context: PaneContext } | null = null;

  private renderTabs() {
    const count = this.tabs.length;
    return html`
      <div class="relative grid rounded-lg border border-zinc-800 bg-zinc-950/40 p-1 shrink-0 overflow-hidden" role="tablist" style=${`grid-template-columns: repeat(${count}, minmax(0, 1fr));`}>
        <span
          class="absolute inset-y-1 left-1 rounded-md bg-blue-500/20 shadow-sm transition-transform duration-200 ease-out will-change-transform"
          style=${`width: calc((100% - 0.5rem) / ${count}); transform: translateX(${this.activeTab * 100}%);`}
          aria-hidden="true"
        ></span>
        ${this.tabs.map((tab, index) => {
          const active = index === this.activeTab;
          return html`
            <button
              role="tab"
              class="relative z-10 px-3 py-1 rounded-md text-sm font-semibold cursor-pointer shrink-0 ${active ? "text-blue-100" : "text-zinc-500 hover:text-zinc-300 transition-colors"}"
              aria-selected=${active ? "true" : "false"}
              @click=${() => { if (!active) this.dispatchEvent(openMainViewEvent(tab.view)); }}
            >${tab.title}</button>
          `;
        })}
      </div>
    `;
  }

  private renderViewTools() {
    const toolbar = this.viewToolbar;
    if (toolbar) {
      return html`<reins-view-mount class="flex min-w-0 flex-1 items-center gap-1.5" .presentation=${toolbar.presentation} .view=${toolbar.view} .context=${toolbar.context}></reins-view-mount>`;
    }
    if (this.tabs.length > 1) return html`<div class="min-w-0 flex-1"></div>`;
    return html`<h1 class="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-zinc-200">${this.pageTitle ?? ""}</h1>`;
  }

  private renderOverflowActions() {
    return html`
      <button
        class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
        @click=${() => this.dispatchEvent(reloadRequestEvent())}
      >Reload</button>
    `;
  }

  override render() {
    return html`
      <div class="h-[50px] flex items-center gap-1.5 border-b border-zinc-800/80 bg-zinc-900/80 px-2 py-1.5 overflow-hidden shrink-0">
        ${this.showSidebarButton ? html`
          <button
            class="p-2 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/70 cursor-pointer shrink-0 transition-colors md:hidden"
            @click=${() => this.dispatchEvent(paneSelectEvent("sessions"))}
            title="Open sidebar"
          >
            ${menuIcon()}
          </button>
        ` : ""}
        ${this.tabs.length > 1 ? this.renderTabs() : ""}
        ${this.renderViewTools()}
        <div class="hidden md:flex items-center gap-1 shrink-0">
          ${this.connected ? statusDot("success", { label: "Connected" }) : statusDot("danger", { label: "Disconnected" })}
        </div>
        ${this.isStandalone ? html`
          <popover-menu
            triggerClass="px-1.5 py-2 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/70 rounded-md"
            panelClass="w-44"
            close-on-panel-click
            .content=${() => this.renderOverflowActions()}
          ></popover-menu>
        ` : ""}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "app-main-toolbar": AppMainToolbar;
  }
}
