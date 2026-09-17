import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import type { ActionMenuPresentation, ActionMenuPresenter } from "../ui/action-menu-presenter.js";
import { copyIcon } from "./icons.js";
import "../ui/action-menu-presenter.js";

@customElement("message-action-menu")
export class MessageActionMenuElement extends LitElement {
  @property({ attribute: false }) copyMessage: (text: string) => Promise<boolean> = async () => false;

  @query("action-menu-presenter") private actionMenuPresenter?: ActionMenuPresenter;

  private text: string | null = null;
  private menuVersion = 0;

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    this.close();
    super.disconnectedCallback();
  }

  get isOpen(): boolean {
    return this.actionMenuPresenter?.isOpen ?? false;
  }

  openSheet(text: string): Promise<void> {
    this.close();
    this.text = text;
    this.menuVersion += 1;
    return this.actionMenuPresenter?.openSheet() ?? Promise.resolve();
  }

  openContext(text: string, x: number, y: number): void {
    this.close();
    this.text = text;
    this.menuVersion += 1;
    this.actionMenuPresenter?.openContext(x, y);
  }

  close(): void {
    this.actionMenuPresenter?.close();
    this.resetMenuState();
  }

  override render() {
    return html`
      <action-menu-presenter
        .ariaLabel=${"Message actions"}
        .contextWidth=${208}
        .contextHeight=${64}
        .content=${(presentation: ActionMenuPresentation) => this.renderAction(presentation)}
        @action-menu-dismiss=${this.resetMenuState}
      ></action-menu-presenter>
    `;
  }

  private renderAction(presentation: ActionMenuPresentation): TemplateResult {
    return html`
      <button
        type="button"
        role=${presentation === "context" ? "menuitem" : undefined}
        class="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium text-zinc-100 active:bg-zinc-700"
        @click=${this.copy}
      >
        ${copyIcon()}
        <span>Copy as Markdown</span>
      </button>
    `;
  }

  private async copy() {
    const text = this.text;
    const menuVersion = this.menuVersion;
    if (text) await this.copyMessage(text);
    if (menuVersion === this.menuVersion) this.close();
  }

  private resetMenuState() {
    this.text = null;
    this.menuVersion += 1;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "message-action-menu": MessageActionMenuElement;
  }
}
