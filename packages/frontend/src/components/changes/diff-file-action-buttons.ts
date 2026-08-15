import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { copyTextToClipboard } from "../../helpers/clipboard.js";
import { isHtml } from "../../models/changes/diff-utils.js";
import { openInBrowserEvent } from "../events.js";
import { checkIcon, copyIcon, downloadFileIcon, eyeIcon } from "../icons.js";

type DiffFileActionButtonVariant = "card" | "header";

function actionClass(variant: DiffFileActionButtonVariant) {
  return variant === "header"
    ? "inline-flex h-5 w-5 items-center justify-center rounded text-xs text-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-200"
    : "inline-flex items-center text-zinc-500 hover:text-zinc-300 transition-colors p-0.5 rounded hover:bg-zinc-700/50 shrink-0";
}

@customElement("diff-view-file-button")
export class DiffViewFileButton extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property() path = "";
  @property() variant: DiffFileActionButtonVariant = "card";

  handleClick(event: Event) {
    event.stopPropagation();
    this.dispatchEvent(openInBrowserEvent(
      this.path,
      isHtml(this.path) ? { viewMode: "preview" } : undefined,
    ));
  }

  override render() {
    return html`
      <span
        role="button"
        tabindex="0"
        title="View file"
        class=${actionClass(this.variant)}
        @click=${this.handleClick}
      >
        ${eyeIcon()}
      </span>
    `;
  }
}

@customElement("diff-copy-path-button")
export class DiffCopyPathButton extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property() path = "";
  @property() variant: DiffFileActionButtonVariant = "card";
  @property({ attribute: false }) copyText: (text: string) => void | Promise<void> = copyTextToClipboard;
  @state() private copied = false;
  private _copyTimer: ReturnType<typeof setTimeout> | null = null;

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._copyTimer) clearTimeout(this._copyTimer);
  }

  async handleClick(event: Event) {
    event.stopPropagation();
    await this.copyText(this.path);
    this.copied = true;
    if (this._copyTimer) clearTimeout(this._copyTimer);
    this._copyTimer = setTimeout(() => {
      this.copied = false;
    }, 1500);
  }

  override render() {
    return html`
      <span
        role="button"
        tabindex="0"
        title="Copy path"
        class=${actionClass(this.variant)}
        @click=${this.handleClick}
      >
        ${this.copied
          ? checkIcon("w-3.5 h-3.5 text-green-400")
          : copyIcon("w-3.5 h-3.5")}
      </span>
    `;
  }
}

@customElement("diff-download-file-button")
export class DiffDownloadFileButton extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property() path = "";
  @property() href = "";
  @property() variant: DiffFileActionButtonVariant = "card";
  @property({ attribute: false }) downloadFile: (href: string, path: string) => void = downloadHref;

  handleClick(event: Event) {
    event.stopPropagation();
    if (!this.href) return;
    this.downloadFile(this.href, this.path);
  }

  override render() {
    return html`
      <span
        role="button"
        tabindex="0"
        title="Download file"
        class=${actionClass(this.variant)}
        @click=${this.handleClick}
      >
        ${downloadFileIcon()}
      </span>
    `;
  }
}

function downloadHref(href: string, path: string) {
  const a = document.createElement("a");
  const separator = href.includes("?") ? "&" : "?";
  a.href = `${href}${separator}download=1`;
  a.download = path.split("/").pop() || path;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

declare global {
  interface HTMLElementTagNameMap {
    "diff-view-file-button": DiffViewFileButton;
    "diff-copy-path-button": DiffCopyPathButton;
    "diff-download-file-button": DiffDownloadFileButton;
  }
}
