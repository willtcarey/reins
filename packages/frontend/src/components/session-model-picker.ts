import { LitElement, html, nothing } from "lit";
import type { PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionData } from "../models/ws-client.js";
import { formatModelSettingLabel } from "../models/settings.js";
import { ModelRegistryStore } from "../models/stores/model-registry-store.js";
import type { ModelSetting } from "../models/stores/settings-store.js";
import { showToast } from "./toast.js";
import "./popover-menu.js";
import "./settings/model-selector-controls.js";

@customElement("session-model-picker")
export class SessionModelPicker extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String })
  sessionId = "";

  @property({ attribute: false })
  sessionData: SessionData | null = null;

  @property({ attribute: false })
  updateSessionModel: ((update: { runtimeType: string; provider: string; modelId: string; thinkingLevel: string }) => Promise<{ ok: true } | { error: string }>) | null = null;

  @state() private _registryStore = new ModelRegistryStore();
  @state() private _loading = false;
  @state() private _saving = false;
  @state() private _selectedRuntimeType = "";
  @state() private _selectedProvider = "";
  @state() private _selectedModel = "";
  @state() private _selectedThinking = "high";

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("sessionData")) {
      this._syncSelectionFromSession();
    }
  }

  private _syncSelectionFromSession() {
    this._selectedProvider = this.sessionData?.state.model?.provider ?? "";
    this._selectedModel = this.sessionData?.state.model?.id ?? "";
    this._selectedRuntimeType = this.sessionData?.runtimeType
      ?? this._registryStore.providers.find(
        (provider) =>
          provider.provider === this._selectedProvider
          && provider.models.some((model) => model.id === this._selectedModel),
      )?.runtimeType
      ?? "";
    this._selectedThinking = this.sessionData?.state.thinkingLevel ?? "high";
  }

  private async _ensureLoaded() {
    if (this._registryStore.providers.length > 0) return;

    this._loading = true;
    const registryResult = await this._registryStore.load();
    this._loading = false;

    if ("error" in registryResult) {
      showToast(`Failed to load models: ${registryResult.error}`, "error");
      return;
    }

    this._syncSelectionFromSession();
  }

  private _currentModel(): ModelSetting | null {
    const model = this.sessionData?.state.model;
    if (!model) return null;
    return {
      provider: model.provider,
      modelId: model.id,
      runtimeType: this.sessionData?.runtimeType ?? this._selectedRuntimeType,
      thinkingLevel: this.sessionData?.state.thinkingLevel ?? "high",
    };
  }

  private _currentLabel() {
    const current = this._currentModel();
    if (!current) return "Session model";

    return formatModelSettingLabel({
      providers: this._registryStore.providers,
      model: current,
      defaultThinkingLevel: "high",
    });
  }

  private get _pickerProviders() {
    const providers = this._registryStore.availableProviders;
    if ((this.sessionData?.state.messageCount ?? 0) === 0) {
      return providers;
    }

    const runtimeType = this.sessionData?.runtimeType ?? this._selectedRuntimeType;
    if (!runtimeType) return providers;
    return providers.filter((provider) => provider.runtimeType === runtimeType);
  }

  private async _saveModel(
    runtimeType: string,
    provider: string,
    modelId: string,
    thinkingLevel: string,
  ): Promise<{ ok: true } | { error: string } | undefined> {
    if (!this.updateSessionModel || !this.sessionId) return undefined;

    this._saving = true;
    try {
      const result = await this.updateSessionModel({ runtimeType, provider, modelId, thinkingLevel });
      if ("error" in result) {
        return { error: result.error };
      }

      showToast("Session model updated", "success");
      return { ok: true };
    } finally {
      this._saving = false;
    }
  }

  private async _handleSelectionChange(e: CustomEvent<{ runtimeType: string; provider: string; modelId: string }>) {
    const previous = {
      runtimeType: this._selectedRuntimeType,
      provider: this._selectedProvider,
      model: this._selectedModel,
    };

    this._selectedRuntimeType = e.detail.runtimeType;
    this._selectedProvider = e.detail.provider;
    this._selectedModel = e.detail.modelId;

    const result = await this._saveModel(
      this._selectedRuntimeType,
      this._selectedProvider,
      this._selectedModel,
      this._selectedThinking,
    );
    if (result && "error" in result) {
      this._selectedRuntimeType = previous.runtimeType;
      this._selectedProvider = previous.provider;
      this._selectedModel = previous.model;
      showToast(`Failed to update session model: ${result.error}`, "error");
    }
  }

  private async _handleThinkingChange(e: CustomEvent<{ thinkingLevel: string }>) {
    const previousThinking = this._selectedThinking;
    this._selectedThinking = e.detail.thinkingLevel;

    const result = await this._saveModel(
      this._selectedRuntimeType,
      this._selectedProvider,
      this._selectedModel,
      this._selectedThinking,
    );
    if (result && "error" in result) {
      this._selectedThinking = previousThinking;
      showToast(`Failed to update session model: ${result.error}`, "error");
    }
  }

  private renderPopoverContent() {
    if (this._loading) {
      return html`<div class="p-3 text-xs text-zinc-400">Loading models...</div>`;
    }

    return html`
      <div class="p-3 w-80 space-y-3">
        <div>
          <div class="text-xs font-medium text-zinc-200">Session model</div>
          <div class="text-[10px] text-zinc-500 mt-1">Changes apply to this session only.</div>
        </div>
        <model-selector-controls
          .providers=${this._pickerProviders}
          .selectedRuntimeType=${this._selectedRuntimeType}
          .selectedProvider=${this._selectedProvider}
          .selectedModel=${this._selectedModel}
          .selectedThinking=${this._selectedThinking}
          .saving=${this._saving}
          .showClear=${false}
          .showCurrent=${false}
          emptyMessage="Configure at least one API key in settings to change the model."
          @selection-change=${(e: CustomEvent<{ runtimeType: string; provider: string; modelId: string }>) => this._handleSelectionChange(e)}
          @thinking-change=${(e: CustomEvent<{ thinkingLevel: string }>) => this._handleThinkingChange(e)}
        ></model-selector-controls>
      </div>
    `;
  }

  override render() {
    if (!this.sessionId || !this.sessionData?.state.model) return nothing;

    return html`
      <popover-menu
        triggerClass="px-0 py-0 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
        panelClass="w-80"
        anchor="right-end"
        .content=${() => this.renderPopoverContent()}
        .triggerTemplate=${html`
          <span class="inline-flex items-center gap-1.5" @click=${() => void this._ensureLoaded()}>
            <span>${this._currentLabel()}</span>
          </span>
        `}
      ></popover-menu>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-model-picker": SessionModelPicker;
  }
}
