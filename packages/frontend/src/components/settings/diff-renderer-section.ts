import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { SettingsStore, type DiffRenderer } from "../../models/stores/settings-store.js";
import { showToast } from "../toast.js";

@customElement("settings-diff-renderer-section")
export class SettingsDiffRendererSection extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store!: SettingsStore;

  override render() {
    const selected = this.store?.diffRenderer ?? "classic";

    return html`
      <h3 class="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Diff renderer</h3>
      <p class="text-[10px] text-zinc-500 mb-3">
        Choose the stored renderer preference. The virtualized prototype is experimental and is not wired to the diff panel yet.
      </p>
      <select
        class="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 disabled:opacity-60"
        .value=${selected}
        @change=${this._handleChange}
        aria-label="Diff renderer"
      >
        <option value="classic">Classic</option>
        <option value="virtual">Virtualized prototype</option>
      </select>
    `;
  }

  private async _handleChange(event: Event) {
    if (!(event.target instanceof HTMLSelectElement)) return;

    const value = event.target.value;
    if (!isDiffRenderer(value)) return;

    const result = await this.store.selectDiffRenderer(value);
    if ("error" in result) {
      showToast(`Failed to update diff renderer: ${result.error}`, "error");
      return;
    }
  }
}

function isDiffRenderer(value: string): value is DiffRenderer {
  return value === "classic" || value === "virtual";
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-diff-renderer-section": SettingsDiffRendererSection;
  }
}
