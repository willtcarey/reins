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

  private async _handleProviderModelChange(e: CustomEvent<{ runtimeType: string; provider: string; modelId: string }>) {
    const store = this.store;
    if (!store) return;

    const selection = e.detail;

    const result = await store.selectModelSetting(
      this.settingKey,
      selection.provider,
      selection.modelId,
      selection.runtimeType,
    );
    if ("error" in result) {
      showToast(`Failed to save model setting: ${result.error}`, "error");
      return;
    }

    const selected = this._selected;
    if (selected.provider && selected.modelId) {
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

    const selected = this._selected;
    if (selected.provider && selected.modelId) {
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
    return this.store?.getStoredModelSetting(this.settingKey) ?? null;
  }

  private get _selected() {
    return this.store?.getSelectedModelSetting(this.settingKey) ?? {
      provider: "",
      modelId: "",
      runtimeType: "",
      thinkingLevel: "high",
    };
  }

  override render() {
    const store = this.store;
    const registryStore = store?.registryStore;
    if (!store || !registryStore) return nothing;

    if (registryStore.loading && registryStore.providers.length === 0) {
      return html`<div class="text-xs text-zinc-500 py-2">Loading model registry...</div>`;
    }

    return html`
      <model-selector-controls
        .providers=${registryStore.availableProviders}
        .selectedRuntimeType=${this._selected.runtimeType}
        .selectedProvider=${this._selected.provider}
        .selectedModel=${this._selected.modelId}
        .selectedThinking=${this._selected.thinkingLevel}
        .currentModel=${this._currentModel}
        .saving=${store.savingModel}
        .emptyMessage=${this.emptyMessage}
        .clearLabel=${this.clearLabel}
        .currentLabel=${this.currentLabel}
        .thinkingDefault=${store.defaultThinkingLevel(this.settingKey)}
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
