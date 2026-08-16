import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { DiffStore } from "../../models/stores/diff-store.js";
import type { DiffRenderer } from "../../models/stores/settings-store.js";
import type { DiffRendererPanel } from "./diff-renderer-panel.js";
import "./diff-panel.js";
import "./codeview-diff-panel.js";
import "./review-diff-panel.js";

@customElement("diff-renderer-shell")
export class DiffRendererShell extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store: DiffStore | null = null;
  @property({ type: Boolean }) visible = false;
  @property() renderer: DiffRenderer = "classic";

  private _pendingScrollPath: string | null = null;

  public scrollToFile(path: string) {
    const panel = this._panel;
    if (panel) {
      panel.scrollToFile(path);
      this._pendingScrollPath = null;
    } else {
      this._pendingScrollPath = path;
    }
  }

  override updated() {
    if (!this._pendingScrollPath) return;
    const panel = this._panel;
    if (!panel) return;

    const path = this._pendingScrollPath;
    this._pendingScrollPath = null;
    panel.scrollToFile(path);
  }

  private get _panel(): DiffRendererPanel | null {
    return this.querySelector("diff-panel")
      ?? this.querySelector("codeview-diff-panel")
      ?? this.querySelector("review-diff-panel");
  }

  override render() {
    if (!this.store) return nothing;

    const store = this.store;
    const payload = this.renderer === "classic" ? store.fullData : store.patchData;
    const payloadVersion = this.renderer === "classic"
      ? store.fullDiffVersion
      : store.patchData.data?.version ?? 0;
    const summaryTotals = store.fileData.data?.files.reduce(
      (totals, file) => ({
        additions: totals.additions + file.additions,
        removals: totals.removals + file.removals,
      }),
      { additions: 0, removals: 0 },
    ) ?? { additions: 0, removals: 0 };
    const panel = (() => {
      switch (this.renderer) {
        case "codeview":
          return html`
            <codeview-diff-panel
              class="block h-full min-h-0 ${this.visible ? "" : "hidden"}"
              .store=${store}
              .visible=${this.visible}
            ></codeview-diff-panel>
          `;
        case "virtualized":
          return html`
            <review-diff-panel
              class="block h-full min-h-0 ${this.visible ? "" : "hidden"}"
              .store=${store}
              .visible=${this.visible}
            ></review-diff-panel>
          `;
        case "classic":
          return html`
            <diff-panel
              class="block h-full min-h-0 ${this.visible ? "" : "hidden"}"
              .store=${store}
              .visible=${this.visible}
            ></diff-panel>
          `;
      }
    })();

    return html`
      <div
        class="h-full min-h-0"
        data-diff-renderer=${this.renderer}
        data-diff-project-id=${store.projectId ?? "none"}
        data-diff-mode=${store.diffMode}
        data-diff-branch=${store.branch ?? "none"}
        data-diff-visible=${this.visible}
        data-diff-files-status=${store.fileData.status}
        data-diff-file-count=${store.fileData.data?.files.length ?? 0}
        data-diff-additions=${summaryTotals.additions}
        data-diff-removals=${summaryTotals.removals}
        data-diff-payload-status=${payload.status}
        data-diff-payload-version=${payloadVersion}
        data-diff-last-files-refresh-at=${store.lastFilesRefreshAt ?? "never"}
        data-diff-last-payload-refresh-at=${store.lastPayloadRefreshAt ?? "never"}
        data-diff-last-refresh-trigger=${store.lastRefreshTrigger ?? "none"}
        data-diff-summary-changed=${store.lastSummaryChanged ?? "unknown"}
      >${panel}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "diff-renderer-shell": DiffRendererShell;
  }
}
