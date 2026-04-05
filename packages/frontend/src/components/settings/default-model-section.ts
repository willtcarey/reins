import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import {
  decodeDefaultModelSelection,
  encodeDefaultModelSelection,
  formatDefaultModelOptionLabel,
  THINKING_LEVELS,
} from "../../models/settings.js";
import { SettingsStore } from "../../models/stores/settings-store.js";
import { showToast } from "../toast.js";

@customElement("settings-default-model-section")
export class SettingsDefaultModelSection extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _storeCtrl = new StoreController<SettingsStore>(this);

  @property({ attribute: false })
  set store(store: SettingsStore | null) {
    this._storeCtrl.store = store;
  }

  get store(): SettingsStore | null {
    return this._storeCtrl.store;
  }

  private async _handleProviderModelChange(e: Event) {
    const store = this.store;
    if (!store || !(e.target instanceof HTMLSelectElement)) return;

    const selection = decodeDefaultModelSelection(e.target.value);
    if (!selection) return;

    const result = await store.selectDefaultModel(selection.provider, selection.modelId);
    if ("error" in result) {
      showToast(`Failed to save default model: ${result.error}`, "error");
      return;
    }

    if (store.selectedProvider && store.selectedModel) {
      showToast("Default model updated", "success");
    }
  }

  private async _handleThinkingChange(e: Event) {
    const store = this.store;
    if (!store || !(e.target instanceof HTMLSelectElement)) return;

    const result = await store.selectThinkingLevel(e.target.value);
    if ("error" in result) {
      showToast(`Failed to save default model: ${result.error}`, "error");
      return;
    }

    if (store.selectedProvider && store.selectedModel) {
      showToast("Default model updated", "success");
    }
  }

  private async _clearDefaultModel() {
    const store = this.store;
    if (!store) return;

    const result = await store.clearDefaultModel();
    if ("error" in result) {
      showToast(`Failed to clear default model: ${result.error}`, "error");
      return;
    }

    showToast("Default model cleared", "success");
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;

    const availableProviders = store.availableProviders;
    const selectedValue = encodeDefaultModelSelection(store.selectedProvider, store.selectedModel);
    const isReasoning = store.isSelectedModelReasoning();

    if (availableProviders.length === 0) {
      return html`
        <p class="text-xs text-zinc-500 py-2">
          Configure at least one API key above to select a default model.
        </p>
      `;
    }

    const selectClass =
      "w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 outline-none focus:border-blue-500 transition-colors cursor-pointer appearance-none";

    return html`
      <div class="space-y-3">
        <div>
          <label class="block text-[10px] text-zinc-400 mb-1">Model</label>
          <select
            class=${selectClass}
            .value=${selectedValue}
            @change=${this._handleProviderModelChange}
            ?disabled=${store.savingModel}
          >
            <option value="">Select a provider and model...</option>
            ${availableProviders.flatMap((provider) =>
              provider.models.map(
                (model) => html`
                  <option
                    value=${encodeDefaultModelSelection(provider.provider, model.id)}
                    ?selected=${provider.provider === store.selectedProvider && model.id === store.selectedModel}
                  >
                    ${formatDefaultModelOptionLabel(provider.provider, model.name)}
                  </option>
                `,
              ),
            )}
          </select>
        </div>

        ${store.selectedModel && isReasoning
          ? html`
            <div>
              <label class="block text-[10px] text-zinc-400 mb-1">Thinking Level</label>
              <select
                class=${selectClass}
                .value=${store.selectedThinking}
                @change=${this._handleThinkingChange}
                ?disabled=${store.savingModel}
              >
                ${THINKING_LEVELS.map(
                  (level) =>
                    html`<option value=${level.value} ?selected=${level.value === store.selectedThinking}>
                      ${level.label}
                    </option>`,
                )}
              </select>
            </div>
          `
          : nothing}

        ${store.defaultModel
          ? html`
            <div class="flex items-center gap-2 pt-1">
              <span class="text-[10px] text-zinc-500">
                Current: ${store.defaultModel.provider} / ${store.defaultModel.modelId}
                ${store.defaultModel.thinkingLevel !== "high"
                  ? `(${store.defaultModel.thinkingLevel})`
                  : ""}
              </span>
              <button
                class="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors"
                @click=${() => void this._clearDefaultModel()}
              >Clear</button>
            </div>
          `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-default-model-section": SettingsDefaultModelSection;
  }
}
