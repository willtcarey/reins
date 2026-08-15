/**
 * Diff Markdown Preview
 *
 * Lit component that renders the markdown view-toggle tabs (Diff / Preview)
 * and the rendered markdown content for a file. Used inside `<diff-file-card>`.
 *
 * Events emitted:
 *  - `toggle-rendered` (no detail) — user clicked to switch modes
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import "../markdown-content.js";
import "../view-mode-tabs.js";
import type { TabDef } from "../view-mode-tabs.js";
import { codeIcon, previewIcon, spinnerIcon } from "../icons.js";

const TABS: TabDef[] = [
  {
    label: "Diff",
    icon: codeIcon(),
  },
  {
    label: "Preview",
    icon: previewIcon(),
  },
];

@customElement("diff-markdown-preview")
export class DiffMarkdownPreview extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Whether the file is currently in rendered (preview) mode. */
  @property({ type: Boolean })
  rendered = false;

  /** Whether the markdown content is currently loading. */
  @property({ type: Boolean })
  loading = false;

  /** The raw markdown text to preview. */
  @property({ attribute: false })
  content: string | null = null;



  private _fireToggle() {
    this.dispatchEvent(new Event("toggle-rendered", { bubbles: true, composed: true }));
  }

  private _onTabChange(e: CustomEvent<number>) {
    const wantsPreview = e.detail === 1;
    if (wantsPreview !== this.rendered) this._fireToggle();
  }

  /** Render the Diff / Preview tab bar. */
  renderViewToggle() {
    return html`
      <view-mode-tabs
        .tabs=${TABS}
        .activeIndex=${this.rendered ? 1 : 0}
        @tab-change=${this._onTabChange}
      ></view-mode-tabs>
    `;
  }

  /** Render the markdown preview content area. */
  renderPreview() {
    // Only show spinner on initial load, not background refreshes
    if (this.loading && !this.content) {
      return html`
        <div class="p-4 text-zinc-500 text-sm flex items-center gap-2">
          ${spinnerIcon()}
          Loading preview…
        </div>
      `;
    }

    if (this.content) {
      return html`
        <div class="p-5">
          <markdown-content .text=${this.content}></markdown-content>
        </div>
      `;
    }

    return html`
      <div class="p-4 text-zinc-500 text-sm">No content available</div>
    `;
  }

  override render() {
    return html`
      ${this.renderViewToggle()}
      ${this.rendered ? this.renderPreview() : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "diff-markdown-preview": DiffMarkdownPreview;
  }
}
