import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { copyTextToClipboard } from "../helpers/clipboard.js";
import { openFileBrowserEvent, paneSelectEvent, reloadRequestEvent } from "./events.js";
import type { MainPaneSelectDetail, MainWorkspacePane } from "./events.js";
import { showToast, type ToastLevel } from "./toast.js";
import "./branch-indicator.js";
import "./nav-icon.js";
import "./popover-menu.js";

@customElement("app-main-toolbar")
export class AppMainToolbar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) activePane: MainWorkspacePane = "chat";
  @property({ type: String }) currentBranch: string | null = null;
  @property({ type: String }) sessionId = "";
  @property({ type: Boolean }) isStandalone = false;
  @property({ type: Boolean }) connected = false;

  /** Action-only feedback dependency; defaults to the app toast mechanism. */
  notify: (message: string, level: ToastLevel) => void = showToast;
  @property({ type: Boolean, attribute: "show-sidebar-button" }) showSidebarButton = false;

  private selectPane(pane: MainPaneSelectDetail["pane"]) {
    this.dispatchEvent(paneSelectEvent(pane));
  }

  private renderMenuIcon() {
    return html`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
  }

  private async copySessionId() {
    if (!this.sessionId) return;

    try {
      await copyTextToClipboard(this.sessionId);
      this.notify("Session ID copied", "success");
    } catch {
      this.notify("Could not copy session ID", "error");
    }
  }

  private renderSessionActions() {
    return html`
      ${this.sessionId ? html`
        <button
          class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
          @click=${() => this.copySessionId()}
        >Copy session ID</button>
      ` : ""}
      ${this.isStandalone ? html`
        <button
          class="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors"
          @click=${() => this.dispatchEvent(reloadRequestEvent())}
        >Reload</button>
      ` : ""}
    `;
  }

  override render() {
    const chatActive = this.activePane === "chat";
    const activeButtonClass = "text-blue-100";
    const inactiveButtonClass = "text-zinc-500 hover:text-zinc-300 transition-colors";

    return html`
      <div class="h-[50px] flex items-center gap-1.5 border-b border-zinc-800/80 bg-zinc-900/80 px-2 py-1.5 overflow-hidden shrink-0">
        ${this.showSidebarButton ? html`
          <button
            class="p-2 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/70 cursor-pointer shrink-0 transition-colors md:hidden"
            @click=${() => this.selectPane("sessions")}
            title="Open sidebar"
          >
            ${this.renderMenuIcon()}
          </button>
        ` : ""}
        <nav-icon icon="folder" label="Browse files" .size=${18}
          @click=${() => this.dispatchEvent(openFileBrowserEvent())}></nav-icon>
        <div class="relative grid grid-cols-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-1 shrink-0 overflow-hidden">
          <span
            class="absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-md bg-blue-500/20 shadow-sm transition-transform duration-200 ease-out will-change-transform ${chatActive ? "translate-x-0" : "translate-x-full"}"
            aria-hidden="true"
          ></span>
          <button
            class="relative z-10 px-3 py-1 rounded-md text-sm font-semibold cursor-pointer shrink-0 ${chatActive ? activeButtonClass : inactiveButtonClass}"
            aria-pressed=${chatActive}
            @click=${() => this.selectPane("chat")}
          >
            Chat
          </button>
          <button
            class="relative z-10 px-3 py-1 rounded-md text-sm font-semibold cursor-pointer shrink-0 ${chatActive ? inactiveButtonClass : activeButtonClass}"
            aria-pressed=${!chatActive}
            @click=${() => this.selectPane("changes")}
          >
            Changes
          </button>
        </div>
        <div class="min-w-0 flex-1 overflow-hidden flex justify-end">
          <branch-indicator class="block min-w-0 max-w-full" .currentBranch=${this.currentBranch}></branch-indicator>
        </div>
        <div class="hidden md:flex items-center gap-1 shrink-0">
          ${this.connected
            ? html`<span class="w-2 h-2 rounded-full bg-green-500" title="Connected"></span>`
            : html`<span class="w-2 h-2 rounded-full bg-red-500" title="Disconnected"></span>`
          }
        </div>
        ${this.sessionId || this.isStandalone ? html`
          <popover-menu
            triggerClass="px-1.5 py-2 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/70 rounded-md"
            panelClass="w-44"
            close-on-panel-click
            .content=${() => this.renderSessionActions()}
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
