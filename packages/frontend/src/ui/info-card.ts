import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { longPress } from "../directives/long-press.js";
import type { ActionMenuPresentation, ActionMenuPresenter } from "./action-menu-presenter.js";
import "./action-menu-presenter.js";

export interface InfoCardAction {
  label: string;
  run: () => unknown;
  tone?: "default" | "danger";
}

@customElement("info-card")
export class InfoCard extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) title = "";
  @property({ type: String }) subtitle: string | null = null;
  @property({ type: String }) href: string | null = null;
  @property({ type: String }) primaryLabel: string | null = null;
  @property({ type: Boolean }) active = false;
  @property({ attribute: false }) leading: TemplateResult | typeof nothing | null | undefined = nothing;
  @property({ attribute: false }) trailing: TemplateResult | typeof nothing | null | undefined = nothing;
  @property({ attribute: false }) actions: readonly InfoCardAction[] = [];

  @query("action-menu-presenter") private actionMenuPresenter?: ActionMenuPresenter;

  private handleActivate() {
    this.dispatchEvent(new CustomEvent("info-card-activate", { bubbles: true, composed: true }));
  }

  private readonly openActionSheet = () => this.actionMenuPresenter?.openSheet();

  private openActionMenu(event: Pick<MouseEvent, "preventDefault" | "clientX" | "clientY">) {
    if (this.actions.length === 0) return;
    event.preventDefault();
    this.actionMenuPresenter?.openContext(event.clientX, event.clientY);
  }

  private openActionMenuFromKeyboard(event: KeyboardEvent) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    if (this.actions.length === 0) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    this.actionMenuPresenter?.openContext(rect.right, rect.bottom);
  }

  private runAction(action: InfoCardAction) {
    this.actionMenuPresenter?.close();
    return action.run();
  }

  private renderActions(presentation: ActionMenuPresentation) {
    const sheet = presentation === "sheet";
    return html`
      ${this.actions.map((action) => html`
        <button
          type="button"
          role=${sheet ? nothing : "menuitem"}
          class="w-full text-left ${sheet ? "min-h-12 px-4 py-3 text-sm font-medium active:bg-zinc-700" : "px-3 py-1.5 text-xs hover:bg-zinc-700"} ${action.tone === "danger" ? "text-red-400" : sheet ? "text-zinc-100" : "text-zinc-300"} cursor-pointer transition-colors"
          @click=${() => this.runAction(action)}
        >${action.label}</button>
      `)}
    `;
  }

  private renderContent() {
    const hasLeading = this.leading != null && this.leading !== nothing;
    return html`
      ${hasLeading ? html`
        <span class="flex shrink-0 items-center">${this.leading}</span>
      ` : nothing}
      <span class="min-w-0 flex-1">
        <span class="block truncate text-xs ${this.active ? "text-blue-300" : "text-zinc-300 group-hover/info-card:text-zinc-100"}">
          ${this.title}
        </span>
        ${this.subtitle ? html`
          <span class="mt-0.5 block truncate text-[10px] text-zinc-500">${this.subtitle}</span>
        ` : nothing}
      </span>
    `;
  }

  override render() {
    const primaryClass = `flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left outline-none cursor-pointer focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500/70 active:bg-zinc-700/60 ${this.actions.length > 0 ? "select-none [-webkit-touch-callout:none] md:select-text" : ""}`;
    const hasTrailing = this.trailing != null && this.trailing !== nothing;

    return html`
      <div
        class="group/info-card flex min-w-0 items-stretch transition-colors ${this.active ? "bg-blue-500/15" : "hover:bg-zinc-800/70"}"
        @contextmenu=${this.openActionMenu}
      >
        ${this.href ? html`
          <a
            ${this.actions.length > 0 ? longPress({ onComplete: this.openActionSheet }) : nothing}
            data-role="info-card-primary"
            class=${primaryClass}
            href=${this.href}
            aria-label=${this.primaryLabel ?? nothing}
            @keydown=${this.openActionMenuFromKeyboard}
          >${this.renderContent()}</a>
        ` : html`
          <button
            ${this.actions.length > 0 ? longPress({ onComplete: this.openActionSheet }) : nothing}
            data-role="info-card-primary"
            class=${primaryClass}
            type="button"
            aria-label=${this.primaryLabel ?? nothing}
            @click=${this.handleActivate}
            @keydown=${this.openActionMenuFromKeyboard}
          >${this.renderContent()}</button>
        `}
        ${hasTrailing ? html`
          <span class="flex shrink-0 items-center pr-2.5">${this.trailing}</span>
        ` : nothing}
        ${this.actions.length > 0 ? html`
          <action-menu-presenter
            .ariaLabel=${"Card actions"}
            .contextHeight=${Math.max(48, this.actions.length * 32)}
            .dismissOnContextMenu=${true}
            .content=${(presentation: ActionMenuPresentation) => this.renderActions(presentation)}
          ></action-menu-presenter>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementEventMap {
    "info-card-activate": CustomEvent<void>;
  }

  interface HTMLElementTagNameMap {
    "info-card": InfoCard;
  }
}
