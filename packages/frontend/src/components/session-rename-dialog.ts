import { LitElement, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import type { CachedSession } from "../models/stores/session-cache.js";
import { saveSessionNameEvent } from "./events.js";

@customElement("session-rename-dialog")
export class SessionRenameDialog extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private sessionId = "";
  @state() private sessionName = "";
  @state() private initialName = "";
  @state() private fallbackName = "";
  @state() private saving = false;

  @query("dialog") private dialog?: HTMLDialogElement;

  open(session: Pick<CachedSession, "id" | "name" | "firstMessage">) {
    this.sessionId = session.id;
    this.sessionName = session.name ?? "";
    this.initialName = this.sessionName;
    this.fallbackName = session.firstMessage ?? "Empty session";
    this.saving = false;
    this.updateComplete.then(() => {
      this.dialog?.showModal();
      const input = this.renderRoot.querySelector<HTMLInputElement>("input");
      input?.focus();
      input?.select();
    });
  }

  close() {
    this.dialog?.close();
  }

  saveComplete(error?: string) {
    this.saving = false;
    if (error) {
      alert(error);
      return;
    }
    this.close();
  }

  private get dirty() {
    return this.sessionName.trim() !== this.initialName.trim();
  }

  private handleSave = () => {
    if (!this.sessionId || !this.dirty || this.saving) return;
    this.saving = true;
    this.dispatchEvent(saveSessionNameEvent({
      sessionId: this.sessionId,
      name: this.sessionName.trim() || null,
    }));
  };

  private handleBackdropClick(event: MouseEvent) {
    if (event.target === this.dialog) this.close();
  }

  private handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      this.handleSave();
    }
    if (event.key === "Escape") this.close();
  }

  override render() {
    return html`
      <dialog
        class="bg-transparent p-0 m-auto max-h-dvh overflow-hidden backdrop:bg-black/50 backdrop:backdrop-blur-sm"
        @click=${this.handleBackdropClick}
      >
        <div
          class="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl w-[calc(100vw-2rem)] max-w-[28rem] p-4"
          @keydown=${this.handleKeydown}
        >
          <h3 class="text-sm font-medium text-zinc-200 mb-3">Rename Session</h3>

          <label for="session-name" class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1">
            Name
          </label>
          <input
            id="session-name"
            type="text"
            class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors"
            .value=${this.sessionName}
            placeholder=${this.fallbackName}
            @input=${(event: Event) => {
              if (event.target instanceof HTMLInputElement) this.sessionName = event.target.value;
            }}
          />
          <p class="mt-1.5 text-[10px] text-zinc-500">Leave blank to use the first message.</p>

          <div class="flex items-center gap-2 mt-4 justify-end">
            <span class="text-[10px] text-zinc-500 mr-auto">${this.saving ? "Saving..." : ""}</span>
            <button
              type="button"
              class="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
              @click=${() => this.close()}
            >Cancel</button>
            <button
              type="button"
              class="px-3 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              @click=${this.handleSave}
              ?disabled=${this.saving || !this.dirty}
            >${this.saving ? "Saving..." : "Save"}</button>
          </div>
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-rename-dialog": SessionRenameDialog;
  }
}
