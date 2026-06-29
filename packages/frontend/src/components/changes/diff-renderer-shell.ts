import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { DiffStore } from "../../models/stores/diff-store.js";
import type { DiffRenderer } from "../../models/stores/settings-store.js";
import type { FileTreeState } from "../../models/changes/file-tree-state.js";
import type { DiffPanel } from "./diff-panel.js";
import type { VirtualDiffPanel } from "./virtual-diff-panel.js";
import "./diff-panel.js";

@customElement("diff-renderer-shell")
export class DiffRendererShell extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store: DiffStore | null = null;
  @property({ attribute: false }) treeState: FileTreeState | null = null;
  @property({ type: Boolean }) visible = false;
  @property() renderer: DiffRenderer = "classic";

  private _virtualPanelImport: Promise<unknown> | null = null;

  override willUpdate() {
    if (this.renderer === "virtual" && !this._virtualPanelImport) {
      this._virtualPanelImport = import("./virtual-diff-panel.js");
    }
  }

  public scrollToFile(path: string) {
    this._panel?.scrollToFile(path);
  }

  private get _panel(): DiffPanel | VirtualDiffPanel | null {
    return this.querySelector("diff-panel") ?? this.querySelector("virtual-diff-panel");
  }

  override render() {
    if (!this.store) return nothing;

    const renderer = this.renderer === "virtual" ? "virtual" : "classic";
    return renderer === "virtual" ? html`
      <virtual-diff-panel
        class="block h-full min-h-0 ${this.visible ? "" : "hidden"}"
        .store=${this.store}
        .treeState=${this.treeState}
        .visible=${this.visible}
      ></virtual-diff-panel>
    ` : html`
      <diff-panel
        class="block h-full min-h-0 ${this.visible ? "" : "hidden"}"
        .store=${this.store}
        .treeState=${this.treeState}
        .visible=${this.visible}
      ></diff-panel>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "diff-renderer-shell": DiffRendererShell;
  }
}
