/**
 * Session Sidebar
 *
 * The sidebar's frame, which the host owns: its header (search, settings, collapse), the collapsed rail with
 * its activity badge (from every session's activity, not from any section), and its body, a stack of the
 * sections extensions register (`reins.sidebar.registerSection`), in the order and with the switches the user
 * set in Settings → Sidebar (`SidebarSections`). Each section draws itself in a `<reins-view-mount>`.
 *
 * Height: each section is as tall as its content, and the body is the sidebar's one scroller.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { SidebarSection } from "@reins/sdk";
import type { AppStore } from "../models/stores/app-store.js";
import { chevronLeftIcon, chevronRightIcon } from "../ui/icons.js";
import { openQuickOpenEvent, openSettingsEvent } from "./events.js";
import { ViewportController } from "../controllers/viewport-controller.js";
import "./nav-icon.js";
import "./view-mount.js";

@customElement("session-sidebar")
export class SessionSidebar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) app: AppStore | null = null;
  @property({ attribute: false }) collapsed = false;
  @property({ attribute: false }) onToggleCollapse: (() => void) | null = null;

  private unsubscribe: Array<() => void> = [];
  private viewport = new ViewportController(this);

  override connectedCallback() {
    super.connectedCallback();
    this.subscribe();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopListening();
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("app")) this.subscribe();
  }

  /** The sections shown change with the registry; the rail's badge with every session's activity. */
  private subscribe() {
    this.stopListening();
    const app = this.app;
    if (!app || !this.isConnected) return;
    const update = () => this.requestUpdate();
    this.unsubscribe = [app.sidebar.subscribe(update), app.projectsStore.subscribe(update)];
  }

  private stopListening() {
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe = [];
  }

  private toggleCollapse() {
    if (this.viewport.isMobileLayout) return;
    this.onToggleCollapse?.();
  }

  private openQuickOpen() {
    this.dispatchEvent(openQuickOpenEvent());
  }

  private openSettings() {
    this.dispatchEvent(openSettingsEvent());
  }

  /** A dot on the collapsed rail while any session runs (green) or has something unread (amber). */
  private renderRailBadge() {
    const summary = this.app?.projectsStore.activitySummary;
    const hasRunning = (summary?.running ?? 0) > 0;
    const hasFinished = (summary?.finished ?? 0) > 0;
    if (!hasRunning && !hasFinished) return nothing;
    const colorClass = hasRunning ? "bg-green-500 animate-pulse" : "bg-amber-500";
    return html`<span class="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${colorClass}" data-role="rail-badge"></span>`;
  }

  private renderSection(section: SidebarSection) {
    const title = section.title ?? section.id;
    return html`
      <section class="shrink-0" aria-label=${title} data-sidebar-section=${section.id}>
        ${section.title ? html`
          <h2 class="shrink-0 px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">${section.title}</h2>
        ` : nothing}
        <reins-view-mount class="block" .presentation=${section}></reins-view-mount>
      </section>
    `;
  }

  private renderBody() {
    const sections = this.app?.sidebar.shown() ?? [];
    if (sections.length === 0) {
      return html`<p class="px-3 py-4 text-xs text-zinc-500">No sidebar sections are on. Turn some on in Settings → Sidebar.</p>`;
    }
    return html`
      <div class="flex-1 min-h-0 overflow-y-auto" data-sidebar-scroll-container data-swipe-surface>
        ${repeat(sections, (section) => section.id, (section) => this.renderSection(section))}
      </div>
    `;
  }

  override render() {
    const isCollapsed = !this.viewport.isMobileLayout && this.collapsed;
    const shellClass = `${isCollapsed ? "md:w-full" : "w-full"}
      h-full bg-zinc-900 border-r border-zinc-700 flex flex-col shrink-0 overflow-hidden
      md:transition-[width] duration-200 ease-out`;

    return html`
      <div class=${shellClass}>
        <div class="flex items-center border-b border-zinc-800/80 shrink-0 ${isCollapsed ? "justify-center" : "h-[50px] px-2 gap-1"}">
          ${isCollapsed ? html`
            <div class="flex flex-col items-center gap-1 py-1">
              <button
                class="relative p-2 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
                @click=${this.toggleCollapse}
                title="Show sidebar"
              >
                ${chevronRightIcon()}
                ${this.renderRailBadge()}
              </button>
              <nav-icon icon="search" label="Search sessions (Cmd+K)" compact @click=${this.openQuickOpen}></nav-icon>
              <nav-icon icon="settings" label="Settings" compact @click=${this.openSettings}></nav-icon>
            </div>
          ` : html`
            <nav-icon icon="search" label="Search sessions (Cmd+K)" .size=${18} @click=${this.openQuickOpen}></nav-icon>
            <nav-icon icon="settings" label="Settings" .size=${18} @click=${this.openSettings}></nav-icon>
            <div class="flex-1 min-w-0"></div>
            <button
              class="hidden md:block p-2 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/70 cursor-pointer transition-colors shrink-0"
              @click=${this.toggleCollapse}
              title="Hide sidebar"
            >
              ${chevronLeftIcon()}
            </button>
          `}
        </div>

        ${isCollapsed ? nothing : this.renderBody()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-sidebar": SessionSidebar;
  }
}
