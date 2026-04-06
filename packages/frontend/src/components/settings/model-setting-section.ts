import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { SettingsStore, type ModelSettingKey } from "../../models/stores/settings-store.js";
import { showToast } from "../toast.js";
import "./model-selector-controls.js";

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

  private async _handleProviderModelChange(e: CustomEvent<{ provider: string; modelId: string }>) {
    const store = this.store;
    if (!store) return;

    const selection = e.detail;

    const result = await store.selectModelSetting(this.settingKey, selection.provider, selection.modelId);
    if ("error" in result) {
      showToast(`Failed to save model setting: ${result.error}`, "error");
      return;
    }

    if (this._selectedProvider && this._selectedModel) {
      showToast(this.successLabel, "success");
    }
  }

  private async _handleThinkingChange(e: CustomEvent<{ thinkingLevel: string }>) {
    const store = this.store;
    if (!store) return;

    const result = await store.selectModelSettingThinkingLevel(this.settingKey, e.detail.thinkingLevel);
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

  override render() {
    const store = this.store;
    if (!store) return nothing;

    return html`
      <model-selector-controls
        .providers=${store.availableProviders}
        .selectedProvider=${this._selectedProvider}
        .selectedModel=${this._selectedModel}
        .selectedThinking=${this._selectedThinking}
        .currentModel=${this._currentModel}
        .saving=${store.savingModel}
        .emptyMessage=${this.emptyMessage}
        .clearLabel=${this.clearLabel}
        .currentLabel=${this.currentLabel}
        .thinkingDefault=${this.settingKey === "default_model" ? "high" : "minimal"}
        @selection-change=${this._handleProviderModelChange}
        @thinking-change=${this._handleThinkingChange}
        @clear=${() => void this._clearModelSetting()}
      ></model-selector-controls>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-model-setting-section": SettingsModelSettingSection;
  }
}
