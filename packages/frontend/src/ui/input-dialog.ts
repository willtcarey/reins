/**
 * The app's one-field question: a modal with a text field, prefilled and selected, Cancel and Save. Save is
 * enabled once the value changed; it awaits the asker's `save`, whose rejection is toasted and keeps the dialog
 * open to try again.
 *
 * Usage:
 *   if (await inputDialog({ heading: "Rename Laptop", label: "Name", value: node.name, save: (name) => rename(name) })) …
 *
 * Mounted in the document the first time it is asked for, as `confirmDialog` is.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { dialogButton } from "./dialog.js";
import { showToast } from "./toast.js";

export interface InputRequest {
  readonly heading: string;
  /** The field's label. */
  readonly label: string;
  /** The value now. */
  readonly value: string;
  /** What shows in an empty field. */
  readonly placeholder?: string;
  /** A line under the field, e.g. what an empty value means. */
  readonly hint?: string;
  /** An empty value cannot be saved. */
  readonly required?: boolean;
  /** The most characters the field takes. */
  readonly maxLength?: number;
  /** Saves the value, trimmed. Its rejection's message is shown, and the dialog stays open. */
  save(value: string): Promise<void>;
}

/** What answers `inputDialog`: the dialog mounted in the document, or a test's stand-in. */
export interface InputHost {
  open(request: InputRequest): Promise<boolean>;
}

let host: InputHost | null = null;

/** Asks `request.heading`; resolves true once saved, false when cancelled. */
export function inputDialog(request: InputRequest): Promise<boolean> {
  if (!host) {
    const dialog = document.createElement("input-dialog");
    document.body.appendChild(dialog);
    host = dialog;
  }
  return host.open(request);
}

/** Answers `inputDialog` with `answerer` in tests (null: mount the dialog in the document again). */
export function setInputHostForTesting(answerer: InputHost | null): void {
  host = answerer;
}

@customElement("input-dialog")
export class InputDialog extends LitElement implements InputHost {
  override createRenderRoot() {
    return this;
  }

  @state() private request: { input: InputRequest; resolve: (saved: boolean) => void } | null = null;
  @state() private value = "";
  @state() private saving = false;

  /** Shows the question; resolves true once saved, false when cancelled (Cancel, Escape, the backdrop). A
   * question still open is cancelled. */
  open(input: InputRequest): Promise<boolean> {
    const previous = this.request;
    return new Promise((resolve) => {
      this.request = { input, resolve };
      this.value = input.value;
      this.saving = false;
      previous?.resolve(false);
    });
  }

  private settle(saved: boolean) {
    const request = this.request;
    if (!request) return;
    this.request = null;
    request.resolve(saved);
  }

  /** Changed, and not empty when it must not be. */
  private get savable() {
    const input = this.request?.input;
    const value = this.value.trim();
    return input !== undefined && value !== input.value.trim() && (value !== "" || !input.required);
  }

  private handleSave = async () => {
    const request = this.request;
    if (!request || !this.savable || this.saving) return;
    this.saving = true;
    try {
      await request.input.save(this.value.trim());
      if (this.request === request) this.settle(true);
    } catch (error) {
      showToast(`Failed to save: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this.saving = false;
    }
  };

  override render() {
    const input = this.request?.input;
    return html`
      <app-dialog
        .open=${input !== undefined}
        heading=${input?.heading ?? ""}
        width="md"
        selectOnOpen
        .onSubmit=${this.handleSave}
        .body=${html`
          <label for="input-dialog-field" class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1">
            ${input?.label ?? ""}
          </label>
          <input
            id="input-dialog-field"
            type="text"
            autofocus
            class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors"
            maxlength=${input?.maxLength ?? nothing}
            .value=${this.value}
            placeholder=${input?.placeholder ?? ""}
            @input=${(event: Event) => {
              if (event.target instanceof HTMLInputElement) this.value = event.target.value;
            }}
          />
          ${input?.hint ? html`<p class="mt-1.5 text-[10px] text-zinc-500">${input.hint}</p>` : ""}
        `}
        .actions=${html`
          <span class="text-[10px] text-zinc-500 mr-auto">${this.saving ? "Saving..." : ""}</span>
          ${dialogButton({ label: "Cancel", onClick: () => this.settle(false) })}
          ${dialogButton({ label: this.saving ? "Saving..." : "Save", variant: "primary", type: "submit", disabled: this.saving || !this.savable })}
        `}
        @dialog-cancel=${() => this.settle(false)}
      ></app-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "input-dialog": InputDialog;
  }
}
