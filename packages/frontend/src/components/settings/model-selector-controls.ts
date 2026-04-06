import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  decodeDefaultModelSelection,
  encodeDefaultModelSelection,
  formatDefaultModelOptionLabel,
  THINKING_LEVELS,
} from "../../models/settings.js";
import type { ModelSetting, ProviderInfo } from "../../models/stores/settings-store.js";

@customElement("model-selector-controls")
export class ModelSelectorControls extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  providers: ProviderInfo[] = [];

  @property({ type: String })
  selectedProvider = "";

  @property({ type: String })
  selectedModel = "";

  @property({ type: String })
  selectedThinking = "high";

  @property({ attribute: false })
  currentModel: ModelSetting | null = null;

  @property({ type: Boolean })
  saving = false;

  @property({ type: String })
  emptyMessage = "Configure at least one API key above to select a model.";

  @property({ type: String })
  clearLabel = "Clear";

  @property({ type: String })
  currentLabel = "Current";

  @property({ type: String })
  thinkingDefault = "high";

  @property({ type: String })
  modelLabel = "Model";

  @property({ type: String })
  thinkingLabel = "Thinking Level";

  @property({ type: String })
  selectPlaceholder = "Select a provider and model...";

  @property({ type: Boolean })
  showCurrent = true;

  private _handleProviderModelChange(e: Event) {
    if (!(e.target instanceof HTMLSelectElement)) return;
    const selection = decodeDefaultModelSelection(e.target.value);
    if (!selection) return;
    this.dispatchEvent(new CustomEvent("selection-change", {
      bubbles: true,
      composed: true,
      detail: selection,
    }));
  }

  private _handleThinkingChange(e: Event) {
    if (!(e.target instanceof HTMLSelectElement)) return;
    this.dispatchEvent(new CustomEvent("thinking-change", {
      bubbles: true,
      composed: true,
      detail: { thinkingLevel: e.target.value },
    }));
  }

  private _handleClear() {
    this.dispatchEvent(new CustomEvent("clear", { bubbles: true, composed: true }));
  }

  private _formatThinkingLevel(thinkingLevel: string): string {
    return thinkingLevel === this.thinkingDefault ? "" : `(${thinkingLevel})`;
  }

  private _isSelectedModelReasoning(): boolean {
    const provider = this.providers.find((candidate) => candidate.provider === this.selectedProvider);
    const model = provider?.models.find((candidate) => candidate.id === this.selectedModel);
    return model?.reasoning ?? false;
  }

  override render() {
    if (this.providers.length === 0) {
      return html`<p class="text-xs text-zinc-500 py-2">${this.emptyMessage}</p>`;
    }

    const selectedValue = encodeDefaultModelSelection(this.selectedProvider, this.selectedModel);
    const isReasoning = this._isSelectedModelReasoning();
    const selectClass =
      "w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 outline-none focus:border-blue-500 transition-colors cursor-pointer appearance-none";

    return html`
      <div class="space-y-3">
        <div>
          <label class="block text-[10px] text-zinc-400 mb-1">${this.modelLabel}</label>
          <select
            class=${selectClass}
            .value=${selectedValue}
            @change=${this._handleProviderModelChange}
            ?disabled=${this.saving}
          >
            <option value="">${this.selectPlaceholder}</option>
            ${this.providers.flatMap((provider) =>
              provider.models.map(
                (model) => html`
                  <option
                    value=${encodeDefaultModelSelection(provider.provider, model.id)}
                    ?selected=${provider.provider === this.selectedProvider && model.id === this.selectedModel}
                  >
                    ${formatDefaultModelOptionLabel(provider.provider, model.name)}
                  </option>
                `,
              ),
            )}
          </select>
        </div>

        ${this.selectedModel && isReasoning
          ? html`
            <div>
              <label class="block text-[10px] text-zinc-400 mb-1">${this.thinkingLabel}</label>
              <select
                class=${selectClass}
                .value=${this.selectedThinking}
                @change=${this._handleThinkingChange}
                ?disabled=${this.saving}
              >
                ${THINKING_LEVELS.map(
                  (level) =>
                    html`<option value=${level.value} ?selected=${level.value === this.selectedThinking}>
                      ${level.label}
                    </option>`,
                )}
              </select>
            </div>
          `
          : nothing}

        ${this.showCurrent && this.currentModel
          ? html`
            <div class="flex items-center gap-2 pt-1">
              <span class="text-[10px] text-zinc-500">
                ${this.currentLabel}: ${this.currentModel.provider} / ${this.currentModel.modelId}
                ${this._formatThinkingLevel(this.currentModel.thinkingLevel)}
              </span>
              <button
                class="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors"
                @click=${() => this._handleClear()}
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
    "model-selector-controls": ModelSelectorControls;
  }
}
