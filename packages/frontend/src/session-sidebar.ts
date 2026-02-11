/**
 * Herald Session Sidebar
 *
 * Collapsible sidebar that lists sessions for the current project,
 * allows switching between them, and creating new sessions.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HeraldClient, SessionListItem } from "./ws-client.js";

@customElement("herald-sessions")
export class HeraldSessions extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  client: HeraldClient | null = null;

  @property({ type: String })
  activeSessionId = "";

  @state() private sessions: SessionListItem[] = [];
  @state() private collapsed = false;
  @state() private loading = false;

  override connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  async refresh() {
    this.loading = true;
    try {
      const resp = await fetch("/api/sessions");
      if (resp.ok) {
        this.sessions = await resp.json();
      }
    } catch {
      // Silently fail — list will be empty
    }
    this.loading = false;
  }

  private handleNewSession() {
    this.client?.newSession();
  }

  private handleSelectSession(path: string) {
    this.client?.switchSession(path);
  }

  private toggleCollapse() {
    this.collapsed = !this.collapsed;
  }

  private formatRelativeDate(iso: string): string {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
  }

  private renderSession(s: SessionListItem) {
    const isActive = s.id === this.activeSessionId;
    const label = s.name || s.firstMessage || "Empty session";
    const truncated = label.length > 60 ? label.slice(0, 60) + "..." : label;
    const date = this.formatRelativeDate(s.modified);

    return html`
      <button
        class="w-full text-left px-3 py-2.5 border-b border-zinc-700/50 cursor-pointer transition-colors
          ${isActive ? "bg-zinc-700/60" : "hover:bg-zinc-700/30"}"
        @click=${() => this.handleSelectSession(s.path)}
      >
        <div class="text-xs ${isActive ? "text-zinc-100" : "text-zinc-300"} truncate">${truncated}</div>
        <div class="text-[10px] text-zinc-500 mt-0.5">${date} · ${s.messageCount} messages</div>
      </button>
    `;
  }

  override render() {
    if (this.collapsed) {
      return html`
        <div class="w-10 h-full bg-zinc-850 border-r border-zinc-700 flex flex-col items-center pt-2 shrink-0">
          <button
            class="p-1.5 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
            @click=${this.toggleCollapse}
            title="Show sessions"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        </div>
      `;
    }

    return html`
      <div class="w-64 h-full bg-zinc-850 border-r border-zinc-700 flex flex-col shrink-0">
        <!-- Header -->
        <div class="flex items-center justify-between px-3 py-2 border-b border-zinc-700">
          <h2 class="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Sessions</h2>
          <button
            class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
            @click=${this.toggleCollapse}
            title="Hide sessions"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
        </div>

        <!-- New session button -->
        <div class="p-2 border-b border-zinc-700">
          <button
            class="w-full py-1.5 px-3 text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600 rounded cursor-pointer transition-colors"
            @click=${this.handleNewSession}
          >
            + New Session
          </button>
        </div>

        <!-- Session list -->
        <div class="flex-1 overflow-y-auto">
          ${this.loading ? html`
            <div class="p-3 text-xs text-zinc-500">Loading...</div>
          ` : this.sessions.length === 0 ? html`
            <div class="p-3 text-xs text-zinc-500">No sessions yet</div>
          ` : this.sessions.map(s => this.renderSession(s))}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "herald-sessions": HeraldSessions;
  }
}
