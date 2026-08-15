import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { checkIcon, copyIcon } from "./icons.js";

const COPY_FEEDBACK_MS = 700;

type MessageActionMenu =
  | { kind: "sheet"; text: string }
  | { kind: "context"; text: string; x: number; y: number };

@customElement("message-action-menu")
export class MessageActionMenuElement extends LitElement {
  @property({ attribute: false }) copyMessage: (text: string) => Promise<boolean> = async () => false;
  @state() private menu: MessageActionMenu | null = null;
  @state() private copied = false;

  private resolveDismissal: (() => void) | null = null;
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    this.close();
    super.disconnectedCallback();
  }

  get isOpen(): boolean {
    return this.menu !== null;
  }

  openSheet(text: string): Promise<void> {
    this.close();
    this.menu = { kind: "sheet", text };
    return new Promise((resolve) => {
      this.resolveDismissal = resolve;
    });
  }

  openContext(text: string, x: number, y: number) {
    this.close();
    this.menu = { kind: "context", text, x, y };
  }

  close() {
    if (this.feedbackTimer !== null) clearTimeout(this.feedbackTimer);
    this.feedbackTimer = null;
    this.copied = false;
    this.menu = null;
    this.resolveDismissal?.();
    this.resolveDismissal = null;
  }

  override updated() {
    const overlay = this.querySelector<HTMLElement>("[data-role=message-action-menu]");
    if (!overlay || overlay.matches(":popover-open")) return;

    overlay.showPopover();
    overlay.querySelector<HTMLElement>("button")?.focus();
  }

  private dismiss() {
    this.close();
  }

  private async copy() {
    const menu = this.menu;
    if (!menu || !await this.copyMessage(menu.text) || this.menu !== menu) {
      this.close();
      return;
    }

    this.copied = true;
    this.feedbackTimer = setTimeout(() => this.close(), COPY_FEEDBACK_MS);
  }

  override render() {
    const menu = this.menu;
    if (!menu) return nothing;

    const action = html`
      <button
        type="button"
        role=${menu.kind === "context" ? "menuitem" : nothing}
        class="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium ${this.copied ? 'text-green-300' : 'text-zinc-100'} active:bg-zinc-700"
        ?disabled=${this.copied}
        @click=${() => this.copy()}
      >
        ${this.copied ? checkIcon() : copyIcon()}
        <span aria-live="polite">${this.copied ? "Copied" : "Copy as Markdown"}</span>
      </button>
    `;

    return html`
      <div
        data-role="message-action-menu"
        popover="manual"
        class="fixed inset-0 m-0 h-[100dvh] max-h-none w-screen max-w-none border-0 ${menu.kind === 'sheet' ? 'bg-black/40' : 'bg-transparent'} p-0 z-[var(--layer-overlay)]"
        role=${menu.kind === "sheet" ? "dialog" : "menu"}
        aria-label="Message actions"
        @click=${() => this.dismiss()}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") this.dismiss();
        }}
      >
        ${menu.kind === "sheet" ? html`
          <div class="absolute inset-x-0 bottom-0 p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]" @click=${(event: Event) => event.stopPropagation()}>
            <div class="overflow-hidden rounded-xl border border-zinc-700 bg-zinc-800 shadow-2xl">
              ${action}
            </div>
            <button
              type="button"
              class="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm font-semibold text-zinc-200 active:bg-zinc-700"
              @click=${() => this.dismiss()}
            >Cancel</button>
          </div>
        ` : html`
          <div
            class="absolute w-52 overflow-hidden rounded-md border border-zinc-600 bg-zinc-800 shadow-xl"
            style=${styleMap(this.contextPosition(menu.x, menu.y))}
            @click=${(event: Event) => event.stopPropagation()}
          >
            ${action}
          </div>
        `}
      </div>
    `;
  }

  private contextPosition(x: number, y: number) {
    const left = Math.max(8, Math.min(x, window.innerWidth - 216));
    const top = Math.max(8, Math.min(y, window.innerHeight - 64));
    return { left: `${left}px`, top: `${top}px` };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "message-action-menu": MessageActionMenuElement;
  }
}
