import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { CachedSession } from "../models/stores/session-cache.js";
import { dialogButton } from "../ui/dialog.js";
import { saveSessionNameEvent } from "./events.js";
import { showToast } from "./toast.js";

@customElement("session-rename-dialog")
export class SessionRenameDialog extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private isOpen = false;
  @state() private sessionId = "";
  @state() private sessionName = "";
  @state() private initialName = "";
  @state() private fallbackName = "";
  @state() private saving = false;

  open(session: Pick<CachedSession, "id" | "name" | "firstMessage">) {
    this.sessionId = session.id;
    this.sessionName = session.name ?? "";
    this.initialName = this.sessionName;
    this.fallbackName = session.firstMessage ?? "Empty session";
    this.saving = false;
    this.isOpen = true;
  }

  close() {
    this.isOpen = false;
  }

  /** Called by the parent once the rename is saved, or with why it failed (the dialog then stays open). */
  saveComplete(error?: string) {
    this.saving = false;
    if (error) {
      showToast(`Failed to rename session: ${error}`, "error");
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

  override render() {
    return html`
      <app-dialog
        .open=${this.isOpen}
        heading="Rename Session"
        width="md"
        selectOnOpen
        .onSubmit=${this.handleSave}
        .body=${html`
          <label for="session-name" class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1">
            Name
          </label>
          <input
            id="session-name"
            type="text"
            autofocus
            class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors"
            .value=${this.sessionName}
            placeholder=${this.fallbackName}
            @input=${(event: Event) => {
              if (event.target instanceof HTMLInputElement) this.sessionName = event.target.value;
            }}
          />
          <p class="mt-1.5 text-[10px] text-zinc-500">Leave blank to use the first message.</p>
        `}
        .actions=${html`
          <span class="text-[10px] text-zinc-500 mr-auto">${this.saving ? "Saving..." : ""}</span>
          ${dialogButton({ label: "Cancel", onClick: () => this.close() })}
          ${dialogButton({ label: this.saving ? "Saving..." : "Save", variant: "primary", type: "submit", disabled: this.saving || !this.dirty })}
        `}
        @dialog-cancel=${() => this.close()}
      ></app-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-rename-dialog": SessionRenameDialog;
  }
}
