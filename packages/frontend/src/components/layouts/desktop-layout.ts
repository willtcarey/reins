import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

type MainWorkspacePane = "chat" | "changes";
type WorkspacePane = "sessions" | MainWorkspacePane | "files";
type WorkspacePanes = Record<WorkspacePane, unknown>;

@customElement("desktop-layout")
export class DesktopLayout extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) activePane: MainWorkspacePane = "chat";
  @property({ attribute: false }) panes: Partial<WorkspacePanes> = {};

  override render() {
    return html`
      <div class="flex h-full min-h-0 min-w-0 overflow-hidden">
        ${this.panes.sessions}

        <div class="flex-1 flex flex-col min-w-0">
          <div class="flex-1 flex min-h-0 ${this.activePane === "chat" ? "" : "hidden"}">
            ${this.panes.chat}
          </div>
          <div class="flex-1 flex flex-col min-h-0 ${this.activePane === "changes" ? "" : "hidden"}">
            ${this.panes.changes}
          </div>
        </div>

        <div class="w-60 border-l border-zinc-700 shrink-0 hidden lg:block">
          ${this.panes.files}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "desktop-layout": DesktopLayout;
  }
}
