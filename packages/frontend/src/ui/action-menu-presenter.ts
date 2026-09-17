import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

export type ActionMenuPresentation = "context" | "sheet";

/** Presents caller-owned actions in a cursor menu or mobile action sheet. */
@customElement("action-menu-presenter")
export class ActionMenuPresenter extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) ariaLabel = "Actions";
  @property({ type: Number }) contextWidth = 160;
  @property({ type: Number }) contextHeight = 48;
  @property({ type: Boolean }) dismissOnContextMenu = false;
  @property({ attribute: false }) content: ((presentation: ActionMenuPresentation) => TemplateResult) | null = null;

  @state() private presentation: { kind: "sheet" } | { kind: "context"; x: number; y: number } | null = null;

  private resolveDismissal: (() => void) | null = null;

  get isOpen(): boolean {
    return this.presentation !== null;
  }

  openContext(x: number, y: number): void {
    this.close();
    this.presentation = { kind: "context", x, y };
  }

  openSheet(): Promise<void> {
    this.close();
    this.presentation = { kind: "sheet" };
    return new Promise((resolve) => {
      this.resolveDismissal = resolve;
    });
  }

  close(): void {
    if (!this.presentation) return;
    this.presentation = null;
    this.resolveDismissal?.();
    this.resolveDismissal = null;
    this.dispatchEvent(new Event("action-menu-dismiss"));
  }

  override disconnectedCallback() {
    this.close();
    super.disconnectedCallback();
  }

  override updated() {
    const overlay = this.querySelector<HTMLElement>("[data-role=action-menu-presenter]");
    if (!overlay || overlay.matches(":popover-open")) return;

    overlay.showPopover();
    overlay.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  }

  override render() {
    const presentation = this.presentation;
    if (!presentation || !this.content) return nothing;

    const sheet = presentation.kind === "sheet";
    return html`
      <div
        data-role="action-menu-presenter"
        popover="manual"
        class="fixed inset-0 m-0 h-[100dvh] max-h-none w-screen max-w-none border-0 ${sheet ? "bg-black/40" : "bg-transparent"} p-0 z-[var(--layer-overlay)]"
        role=${sheet ? "dialog" : "menu"}
        aria-label=${this.ariaLabel}
        @click=${this.close}
        @contextmenu=${this.handleBackdropContextMenu}
        @keydown=${this.handleKeyDown}
      >
        ${sheet ? html`
          <div
            class="absolute inset-x-0 bottom-0 p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
            @click=${(event: Event) => event.stopPropagation()}
          >
            <div class="overflow-hidden rounded-xl border border-zinc-700 bg-zinc-800 shadow-2xl">
              ${this.content("sheet")}
            </div>
            <button
              type="button"
              class="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm font-semibold text-zinc-200 active:bg-zinc-700"
              @click=${this.close}
            >Cancel</button>
          </div>
        ` : html`
          <div
            class="absolute overflow-hidden rounded-md border border-zinc-600 bg-zinc-800 shadow-xl"
            style=${this.contextStyle(presentation.x, presentation.y)}
            @click=${(event: Event) => event.stopPropagation()}
          >
            ${this.content("context")}
          </div>
        `}
      </div>
    `;
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") this.close();
  }

  private handleBackdropContextMenu(event: MouseEvent) {
    if (!this.dismissOnContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  }

  private contextStyle(x: number, y: number): string {
    const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
    const left = Math.max(8, Math.min(x, viewportWidth - this.contextWidth - 8));
    const top = Math.max(8, Math.min(y, viewportHeight - this.contextHeight));
    return `left: ${left}px; top: ${top}px; width: ${this.contextWidth}px`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "action-menu-presenter": ActionMenuPresenter;
  }
}
