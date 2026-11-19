import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { DecisionModelStore } from "../../models/stores/decision-model-store.js";
import { showToast } from "../../ui/toast.js";

const SELECT_CLASS = "w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 outline-none focus:border-blue-500 transition-colors cursor-pointer appearance-none";

/** The default decision model: one of `reins.decisions.list()`, or none. */
@customElement("settings-decision-model-section")
export class SettingsDecisionModelSection extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _storeCtrl = new StoreController<DecisionModelStore>(this);

  @property({ attribute: false })
  set store(store: DecisionModelStore | null) {
    this._storeCtrl.store = store;
  }

  get store(): DecisionModelStore | null {
    return this._storeCtrl.store;
  }

  private async _select(event: Event) {
    if (!(event.target instanceof HTMLSelectElement) || !this.store) return;
    const result = await this.store.select(event.target.value || null);
    if ("error" in result) showToast(`Failed to save the decision model: ${result.error}`, "error");
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;
    if (store.loading && store.models.length === 0) return html`<div class="text-xs text-zinc-500 py-2">Loading decision models...</div>`;
    const { models, selected } = store;
    if (models.length === 0 && selected === null) {
      return html`<p class="text-xs text-zinc-500 py-2">No decision models: sign in to a provider that has them, or add an extension that provides them.</p>`;
    }
    const missing = selected !== null && !models.some(model => model.id === selected);
    return html`
      <select class=${SELECT_CLASS} aria-label="Decision model" .value=${selected ?? ""} @change=${(event: Event) => void this._select(event)}>
        <option value="" ?selected=${selected === null}>None</option>
        ${missing ? html`<option value=${selected} selected>${selected} (unavailable)</option>` : nothing}
        ${models.map(model => html`
          <option value=${model.id} ?selected=${model.id === selected}>${model.name === model.id ? model.id : `${model.name} (${model.id})`}</option>
        `)}
      </select>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-decision-model-section": SettingsDecisionModelSection;
  }
}
