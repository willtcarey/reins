/**
 * Dialog
 *
 * The app's modal dialog shell: a native `<dialog>` shown modally (above
 * everything, focus kept inside, the page behind inert) with the shared
 * backdrop and panel, a heading, an optional subtitle, the owner's body and
 * an actions row.
 *
 * The owner controls it: it shows while `open`, and asks to be cancelled
 * with a `dialog-cancel` event (Escape, a click on the backdrop, the browser
 * closing it) rather than closing itself; the owner sets `open = false`.
 * Once shown it focuses the element in it marked `autofocus` (and, with
 * `selectOnOpen`, selects its text).
 *
 * With `onSubmit` it is a form: body and actions are one `<form>`, so a
 * `type: "submit"` button or Enter in a field submits it, as does
 * ⌘/Ctrl+Enter anywhere in it (for a textarea, where Enter is a newline).
 * The form's own submission is prevented; `onSubmit` does the work and
 * should ignore a submit while one is in flight.
 *
 * Usage:
 *   <app-dialog
 *     .open=${this.open}
 *     heading="Move Session"
 *     .body=${html`…`}
 *     .actions=${html`${dialogButton({ label: "Cancel", onClick: close })}${dialogButton({ label: "Move", variant: "primary", onClick: move, autofocus: true })}`}
 *     @dialog-cancel=${close}
 *   ></app-dialog>
 *
 * The body and actions are rendered by this element, so bind their event
 * handlers as arrow functions: an unbound method would get this element as
 * its `this`.
 */

import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, query } from "lit/decorators.js";

/** `sm`: 24rem (forms, confirmations); `md`: 28rem. Both leave a 1rem margin on a phone. */
export type DialogWidth = "sm" | "md";

const PANEL_WIDTHS: Record<DialogWidth, string> = {
  sm: "max-w-96",
  md: "max-w-[28rem]",
};

export type DialogButtonVariant = "cancel" | "primary" | "destructive";

const BUTTON_CLASSES: Record<DialogButtonVariant, string> = {
  cancel: "px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
  primary: "px-3 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
  destructive: "px-3 py-1.5 text-xs text-white bg-red-600 hover:bg-red-500 rounded cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
};

/** A button for a dialog's actions row, styled by what it does. */
export function dialogButton({ label, variant = "cancel", onClick, type = "button", disabled = false, autofocus = false }: {
  label: unknown;
  variant?: DialogButtonVariant;
  onClick?: (event: Event) => void;
  type?: "button" | "submit";
  disabled?: boolean;
  autofocus?: boolean;
}): TemplateResult {
  return html`<button
    type=${type}
    class=${BUTTON_CLASSES[variant]}
    ?disabled=${disabled}
    ?autofocus=${autofocus}
    @click=${onClick}
  >${label}</button>`;
}

let nextHeadingId = 0;

@customElement("app-dialog")
export class AppDialog extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) open = false;
  @property() heading = "";
  @property({ attribute: false }) subtitle: unknown = nothing;
  @property({ attribute: false }) body: unknown = nothing;
  @property({ attribute: false }) actions: unknown = nothing;
  @property() width: DialogWidth = "sm";
  /** Makes it a form submitted by its submit buttons, Enter in a field and ⌘/Ctrl+Enter. */
  @property({ attribute: false }) onSubmit: (() => void) | null = null;
  /** Selects the autofocused field's text once shown (e.g. a name to rename). */
  @property({ type: Boolean }) selectOnOpen = false;

  @query("dialog") private _dialog?: HTMLDialogElement;

  private readonly _headingId = `app-dialog-heading-${nextHeadingId++}`;

  /** Closing before Lit removes the element ends the modal state cleanly and gives focus back. */
  override willUpdate() {
    if (!this.open && this._dialog?.open) this._dialog.close();
  }

  override updated() {
    const dialog = this._dialog;
    if (!this.open || !dialog || dialog.open) return;
    dialog.showModal();
    const field = dialog.querySelector<HTMLElement>("[autofocus]");
    field?.focus();
    if (this.selectOnOpen && field && "select" in field && typeof field.select === "function") field.select();
  }

  private _requestCancel() {
    this.dispatchEvent(new CustomEvent("dialog-cancel"));
  }

  /** Escape (a close request): the owner decides, so the browser does not close it. */
  private _handleCancel = (event: Event) => {
    event.preventDefault();
    this._requestCancel();
  };

  /** A click on the `<dialog>` itself, not its panel, is a click on the backdrop. */
  private _handleClick = (event: Event) => {
    if (event.target === event.currentTarget) this._requestCancel();
  };

  private _handleSubmit = (event: Event) => {
    event.preventDefault();
    this.onSubmit?.();
  };

  private _handleKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    this.onSubmit?.();
  };

  /** Closed by the browser while still open (a close request it would not let us cancel). The event comes
   * a task after a close, so one from closing before the dialog was shown again is ignored. */
  private _handleClose = () => {
    if (this.open && !this._dialog?.open) this._requestCancel();
  };

  override render() {
    if (!this.open) return nothing;
    const hasSubtitle = this.subtitle !== nothing && this.subtitle !== undefined && this.subtitle !== "";
    const panelClass = `bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl w-[calc(100vw-2rem)] ${PANEL_WIDTHS[this.width]} p-4`;
    const content = html`
      <h3 id=${this._headingId} class="text-sm font-medium text-zinc-200 ${hasSubtitle ? "" : "mb-3"}">${this.heading}</h3>
      ${hasSubtitle ? html`<p class="mt-0.5 mb-3 truncate text-[10px] text-zinc-500">${this.subtitle}</p>` : nothing}
      ${this.body}
      ${this.actions === nothing ? nothing : html`<div class="flex items-center gap-2 mt-4 justify-end">${this.actions}</div>`}
    `;

    return html`
      <dialog
        class="bg-transparent p-0 m-auto max-h-dvh overflow-hidden backdrop:bg-black/50 backdrop:backdrop-blur-sm"
        aria-labelledby=${this._headingId}
        @click=${this._handleClick}
        @cancel=${this._handleCancel}
        @close=${this._handleClose}
      >
        ${this.onSubmit
          ? html`<form class=${panelClass} @submit=${this._handleSubmit} @keydown=${this._handleKeydown}>${content}</form>`
          : html`<div class=${panelClass}>${content}</div>`}
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementEventMap {
    "dialog-cancel": CustomEvent<void>;
  }

  interface HTMLElementTagNameMap {
    "app-dialog": AppDialog;
  }
}
