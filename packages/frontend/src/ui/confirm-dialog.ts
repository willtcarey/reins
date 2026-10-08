/**
 * Confirm Dialog
 *
 * The app's confirmation: a modal question with Cancel and a confirm button,
 * instead of `window.confirm()`, which the Mac app's webview never shows
 * (it answers false at once).
 *
 * Usage:
 *   import { confirmDialog } from "../ui/confirm-dialog.js";
 *   if (!(await confirmDialog({ title: "Remove Laptop?", message: "…", confirmLabel: "Remove", destructive: true }))) return;
 *
 * Built on the dialog shell (`ui/dialog.ts`): Escape and a click on the
 * backdrop cancel. Focus starts on the confirm button, so Enter confirms.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { dialogButton } from "./dialog.js";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  /** The action destroys something: its button is red. */
  destructive?: boolean;
}

/** What answers `confirmDialog`: the dialog mounted in the document, or a test's stand-in. */
export interface ConfirmHost {
  open(options: ConfirmOptions): Promise<boolean>;
}

let host: ConfirmHost | null = null;

/** Asks `options.title`; resolves true when confirmed, false when cancelled. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (!host) {
    const dialog = document.createElement("confirm-dialog");
    document.body.appendChild(dialog);
    host = dialog;
  }
  return host.open(options);
}

/** Answers `confirmDialog` with `answerer` in tests (null: mount the dialog in the document again). */
export function setConfirmHostForTesting(answerer: ConfirmHost | null): void {
  host = answerer;
}

@customElement("confirm-dialog")
export class ConfirmDialog extends LitElement implements ConfirmHost {
  override createRenderRoot() {
    return this;
  }

  @state() private _request: { options: ConfirmOptions; resolve: (confirmed: boolean) => void } | null = null;

  /** Shows the question; resolves true when confirmed, false when cancelled (Cancel, Escape, the
   * backdrop). A question still open is cancelled. */
  open(options: ConfirmOptions): Promise<boolean> {
    const previous = this._request;
    return new Promise((resolve) => {
      this._request = { options, resolve };
      previous?.resolve(false);
    });
  }

  private _settle(confirmed: boolean) {
    const request = this._request;
    if (!request) return;
    this._request = null;
    request.resolve(confirmed);
  }

  override render() {
    const options = this._request?.options;

    return html`
      <app-dialog
        .open=${options !== undefined}
        heading=${options?.title ?? ""}
        .body=${options ? html`<p class="text-xs text-zinc-300 whitespace-pre-line">${options.message}</p>` : nothing}
        .actions=${options ? html`
          ${dialogButton({ label: "Cancel", onClick: () => this._settle(false) })}
          ${dialogButton({ label: options.confirmLabel, variant: options.destructive ? "destructive" : "primary", onClick: () => this._settle(true), autofocus: true })}
        ` : nothing}
        @dialog-cancel=${() => this._settle(false)}
      ></app-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "confirm-dialog": ConfirmDialog;
  }
}
