import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionData } from "../models/ws-client.js";
import { providerLabel, THINKING_LEVELS } from "../models/settings.js";
import { SettingsStore, type ModelSetting } from "../models/stores/settings-store.js";
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
  updateSessionModel: ((update: { provider: string; modelId: string; thinkingLevel: string }) => Promise<{ ok: true } | { error: string }>) | null = null;

  @state() private _store = new SettingsStore();
  @state() private _loading = false;
  @state() private _saving = false;
  @state() private _selectedProvider = "";
  @state() private _selectedModel = "";
  @state() private _selectedThinking = "high";

  override updated(changed: Map<string, unknown>) {
    if (changed.has("sessionData")) {
      this._syncSelectionFromSession();
    }
  }

  private _syncSelectionFromSession() {
    this._selectedProvider = this.sessionData?.state.model?.provider ?? "";
    this._selectedModel = this.sessionData?.state.model?.id ?? "";
    this._selectedThinking = this.sessionData?.state.thinkingLevel ?? "high";
  }

  private async _ensureLoaded() {
    if (this._store.providers.length > 0) return;
    this._loading = true;
    const result = await this._store.load();
    this._loading = false;
    if ("error" in result) {
      showToast(`Failed to load models: ${result.error}`, "error");
    }
  }

  private _currentModel(): ModelSetting | null {
    const model = this.sessionData?.state.model;
    if (!model) return null;
    return {
      provider: model.provider,
      modelId: model.id,
      thinkingLevel: this.sessionData?.state.thinkingLevel ?? "high",
    };
  }

  private _currentLabel() {
    const current = this._currentModel();
    if (!current) return "Session model";

    const allMatchingModels = this._store.providers.flatMap((provider) =>
      provider.models
        .filter((model) => model.id === current.modelId)
        .map((model) => ({ provider: provider.provider, name: model.name })),
    );

    const currentModelName = this._store.providers
      .find((provider) => provider.provider === current.provider)
      ?.models.find((model) => model.id === current.modelId)
      ?.name ?? current.modelId;

    const providerNeeded = allMatchingModels.some((match) => match.provider !== current.provider);
    const thinkingIsDefault = current.thinkingLevel === "high";
    const thinking = THINKING_LEVELS.find((level) => level.value === current.thinkingLevel)?.label ?? current.thinkingLevel;

    const parts = [providerNeeded ? `${providerLabel(current.provider)} / ${currentModelName}` : currentModelName];
    if (!thinkingIsDefault) {
      parts.push(thinking);
    }
    return parts.join(" · ");
  }

  private async _saveModel(provider: string, modelId: string, thinkingLevel: string) {
    if (!this.updateSessionModel || !this.sessionId) return;

    this._saving = true;
    try {
      const result = await this.updateSessionModel({ provider, modelId, thinkingLevel });
      if ("error" in result) {
        showToast(`Failed to update session model: ${result.error}`, "error");
        return;
      }

      this._syncSelectionFromSession();
      showToast("Session model updated", "success");
    } finally {
      this._saving = false;
    }
  }

  private async _handleSelectionChange(e: CustomEvent<{ provider: string; modelId: string }>) {
    this._selectedProvider = e.detail.provider;
    this._selectedModel = e.detail.modelId;
    await this._saveModel(this._selectedProvider, this._selectedModel, this._selectedThinking);
  }

  private async _handleThinkingChange(e: CustomEvent<{ thinkingLevel: string }>) {
    this._selectedThinking = e.detail.thinkingLevel;
    await this._saveModel(this._selectedProvider, this._selectedModel, this._selectedThinking);
  }

  private async _applyDefault() {
    const model = this._store.defaultModel;
    if (!model) return;
    this._selectedProvider = model.provider;
    this._selectedModel = model.modelId;
    this._selectedThinking = model.thinkingLevel;
    await this._saveModel(model.provider, model.modelId, model.thinkingLevel);
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
          .providers=${this._store.availableProviders}
          .selectedProvider=${this._selectedProvider}
          .selectedModel=${this._selectedModel}
          .selectedThinking=${this._selectedThinking}
          .currentModel=${this._currentModel()}
          .saving=${this._saving}
          emptyMessage="Configure at least one API key in settings to change the model."
          clearLabel="Use global default"
          currentLabel="Current"
          @selection-change=${(e: CustomEvent<{ provider: string; modelId: string }>) => this._handleSelectionChange(e)}
          @thinking-change=${(e: CustomEvent<{ thinkingLevel: string }>) => this._handleThinkingChange(e)}
          @clear=${() => void this._applyDefault()}
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
