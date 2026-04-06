import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import {
  decodeDefaultModelSelection,
  encodeDefaultModelSelection,
  formatDefaultModelOptionLabel,
  THINKING_LEVELS,
} from "../../models/settings.js";
import { SettingsStore, type ModelSettingKey } from "../../models/stores/settings-store.js";
import { showToast } from "../toast.js";

@customElement("settings-model-setting-section")
export class SettingsModelSettingSection extends LitElement {
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

  @property()
  settingKey: ModelSettingKey = "default_model";

  @property()
  emptyMessage = "Configure at least one API key above to select a model.";

  @property()
  successLabel = "Model updated";

  @property()
  clearLabel = "Clear";

  @property()
  currentLabel = "Current";

  @property()
  clearSuccessLabel = "Model setting cleared";

  private async _handleProviderModelChange(e: Event) {
    const store = this.store;
    if (!store || !(e.target instanceof HTMLSelectElement)) return;

    const selection = decodeDefaultModelSelection(e.target.value);
    if (!selection) return;

    const result = await store.selectModelSetting(this.settingKey, selection.provider, selection.modelId);
    if ("error" in result) {
      showToast(`Failed to save model setting: ${result.error}`, "error");
      return;
    }

    if (this._selectedProvider && this._selectedModel) {
      showToast(this.successLabel, "success");
    }
  }

  private async _handleThinkingChange(e: Event) {
    const store = this.store;
    if (!store || !(e.target instanceof HTMLSelectElement)) return;

    const result = await store.selectModelSettingThinkingLevel(this.settingKey, e.target.value);
    if ("error" in result) {
      showToast(`Failed to save model setting: ${result.error}`, "error");
      return;
    }

    if (this._selectedProvider && this._selectedModel) {
      showToast(this.successLabel, "success");
    }
  }

  private async _clearModelSetting() {
    const store = this.store;
    if (!store) return;

    const result = await store.clearModelSetting(this.settingKey);
    if ("error" in result) {
      showToast(`Failed to clear model setting: ${result.error}`, "error");
      return;
    }

    showToast(this.clearSuccessLabel, "success");
  }

  private get _currentModel() {
    const store = this.store;
    if (!store) return null;
    return this.settingKey === "default_model" ? store.defaultModel : store.utilityModel;
  }

  private get _selectedProvider() {
    const store = this.store;
    if (!store) return "";
    return this.settingKey === "default_model" ? store.selectedProvider : store.selectedUtilityProvider;
  }

  private get _selectedModel() {
    const store = this.store;
    if (!store) return "";
    return this.settingKey === "default_model" ? store.selectedModel : store.selectedUtilityModel;
  }

  private get _selectedThinking() {
    const store = this.store;
    if (!store) return "high";
    return this.settingKey === "default_model" ? store.selectedThinking : store.selectedUtilityThinking;
  }

  private _formatThinkingLevel(thinkingLevel: string): string {
    const defaultThinkingLevel = this.settingKey === "default_model" ? "high" : "minimal";
    return thinkingLevel === defaultThinkingLevel ? "" : `(${thinkingLevel})`;
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;

    const availableProviders = store.availableProviders;
    const selectedValue = encodeDefaultModelSelection(this._selectedProvider, this._selectedModel);
    const isReasoning = store.isSelectedModelReasoning(this.settingKey);
    const currentModel = this._currentModel;

    if (availableProviders.length === 0) {
      return html`
        <p class="text-xs text-zinc-500 py-2">
          ${this.emptyMessage}
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
                    ?selected=${provider.provider === this._selectedProvider && model.id === this._selectedModel}
                  >
                    ${formatDefaultModelOptionLabel(provider.provider, model.name)}
                  </option>
                `,
              ),
            )}
          </select>
        </div>

        ${this._selectedModel && isReasoning
          ? html`
            <div>
              <label class="block text-[10px] text-zinc-400 mb-1">Thinking Level</label>
              <select
                class=${selectClass}
                .value=${this._selectedThinking}
                @change=${this._handleThinkingChange}
                ?disabled=${store.savingModel}
              >
                ${THINKING_LEVELS.map(
                  (level) =>
                    html`<option value=${level.value} ?selected=${level.value === this._selectedThinking}>
                      ${level.label}
                    </option>`,
                )}
              </select>
            </div>
          `
          : nothing}

        ${currentModel
          ? html`
            <div class="flex items-center gap-2 pt-1">
              <span class="text-[10px] text-zinc-500">
                ${this.currentLabel}: ${currentModel.provider} / ${currentModel.modelId}
                ${this._formatThinkingLevel(currentModel.thinkingLevel)}
              </span>
              <button
                class="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors"
                @click=${() => void this._clearModelSetting()}
              >${this.clearLabel}</button>
            </div>
          `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-model-setting-section": SettingsModelSettingSection;
  }
}
