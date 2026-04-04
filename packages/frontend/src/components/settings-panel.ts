/**
 * Settings Panel
 *
 * Full-screen overlay for managing global settings:
 * - API Keys: configure keys per provider (Anthropic, OpenAI, OpenRouter)
 * - Default Model: select the default provider, model, and thinking level
 *
 * Fetches directly from the settings/models API. Auto-persists on every
 * change (blur/enter for text inputs, change for dropdowns). No save button.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { showToast } from "./toast.js";

// ---- Types ------------------------------------------------------------------

interface ProviderInfo {
  provider: string;
  hasKey: boolean;
  keySource: "db" | "env" | null;
  models: ModelInfo[];
}

interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
}

interface DefaultModel {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

interface ApiKeyState {
  provider: string;
  /** Display label */
  label: string;
  /** Whether a key is configured (DB or env) */
  configured: boolean;
  /** Source of the active key */
  keySource: "db" | "env" | null;
  /** Current input value (empty string = no draft) */
  inputValue: string;
  /** Whether we're currently saving */
  saving: boolean;
}

const KNOWN_PROVIDERS: { provider: string; label: string }[] = [
  { provider: "anthropic", label: "Anthropic" },
  { provider: "openai", label: "OpenAI" },
  { provider: "openrouter", label: "OpenRouter" },
];

const THINKING_LEVELS = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

@customElement("settings-panel")
export class SettingsPanel extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private _open = false;
  @state() private _loading = true;

  // API Keys state
  @state() private _apiKeys: ApiKeyState[] = [];

  // Models state
  @state() private _providers: ProviderInfo[] = [];
  @state() private _defaultModel: DefaultModel | null = null;
  @state() private _savingModel = false;

  // Selected values for cascading dropdowns
  @state() private _selectedProvider = "";
  @state() private _selectedModel = "";
  @state() private _selectedThinking = "high";

  /** Open the settings panel. */
  open() {
    this._open = true;
    this._loading = true;
    this._loadData();
  }

  /** Close the settings panel. */
  close() {
    this._open = false;
  }

  // ---- Data loading ---------------------------------------------------------

  private async _loadData() {
    try {
      const [providersRes, defaultModelRes, settingsRes] = await Promise.all([
        fetch("/api/models"),
        fetch("/api/settings/default_model"),
        fetch("/api/settings"),
      ]);

      // Parse providers
      if (providersRes.ok) {
        this._providers = await providersRes.json();
      }

      // Parse default model
      if (defaultModelRes.ok) {
        const data = await defaultModelRes.json();
        this._defaultModel = data.value ?? null;
      } else {
        this._defaultModel = null;
      }

      // Parse settings list (for checking which API keys are configured)
      let settingsEntries: { key: string; redacted: boolean }[] = [];
      if (settingsRes.ok) {
        settingsEntries = await settingsRes.json();
      }

      // Build API key states
      this._apiKeys = KNOWN_PROVIDERS.map(({ provider, label }) => {
        const providerInfo = this._providers.find((p) => p.provider === provider);
        const settingEntry = settingsEntries.find(
          (s) => s.key === `api_key_${provider}`,
        );

        return {
          provider,
          label,
          configured: settingEntry != null || providerInfo?.keySource === "env",
          keySource: providerInfo?.keySource ?? null,
          inputValue: "",
          saving: false,
        };
      });

      // Set selected dropdowns from default model
      if (this._defaultModel) {
        this._selectedProvider = this._defaultModel.provider;
        this._selectedModel = this._defaultModel.modelId;
        this._selectedThinking = this._defaultModel.thinkingLevel;
      } else {
        this._selectedProvider = "";
        this._selectedModel = "";
        this._selectedThinking = "high";
      }
    } catch {
      showToast("Failed to load settings", "error");
    } finally {
      this._loading = false;
    }
  }

  // ---- API Key handlers -----------------------------------------------------

  private _updateKeyInput(provider: string, value: string) {
    this._apiKeys = this._apiKeys.map((k) =>
      k.provider === provider ? { ...k, inputValue: value } : k,
    );
  }

  private async _saveApiKey(provider: string) {
    const keyState = this._apiKeys.find((k) => k.provider === provider);
    if (!keyState || !keyState.inputValue.trim()) return;

    this._apiKeys = this._apiKeys.map((k) =>
      k.provider === provider ? { ...k, saving: true } : k,
    );

    try {
      const res = await fetch(`/api/settings/api_key_${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(keyState.inputValue.trim()),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed to save" }));
        showToast(data.error || "Failed to save API key", "error");
      } else {
        showToast(`${keyState.label} API key saved`, "success");
        // Reload data to refresh key status and available models
        await this._loadData();
      }
    } catch {
      showToast("Failed to save API key", "error");
    }

    this._apiKeys = this._apiKeys.map((k) =>
      k.provider === provider ? { ...k, saving: false } : k,
    );
  }

  private async _deleteApiKey(provider: string) {
    const keyState = this._apiKeys.find((k) => k.provider === provider);
    if (!keyState) return;

    try {
      const res = await fetch(`/api/settings/api_key_${provider}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        showToast("Failed to remove API key", "error");
      } else {
        showToast(`${keyState.label} API key removed`, "success");
        await this._loadData();
      }
    } catch {
      showToast("Failed to remove API key", "error");
    }
  }

  private _handleKeyDown(e: KeyboardEvent, provider: string) {
    if (e.key === "Enter") {
      e.preventDefault();
      this._saveApiKey(provider);
    }
  }

  // ---- Default Model handlers -----------------------------------------------

  private _handleProviderChange(e: Event) {
    if (!(e.target instanceof HTMLSelectElement)) return;
    this._selectedProvider = e.target.value;

    // Reset model and thinking when provider changes
    const providerModels = this._getModelsForProvider(this._selectedProvider);
    this._selectedModel = providerModels.length > 0 ? providerModels[0].id : "";
    this._selectedThinking = "high";

    if (this._selectedProvider && this._selectedModel) {
      this._persistDefaultModel();
    }
  }

  private _handleModelChange(e: Event) {
    if (!(e.target instanceof HTMLSelectElement)) return;
    this._selectedModel = e.target.value;

    if (this._selectedProvider && this._selectedModel) {
      this._persistDefaultModel();
    }
  }

  private _handleThinkingChange(e: Event) {
    if (!(e.target instanceof HTMLSelectElement)) return;
    this._selectedThinking = e.target.value;

    if (this._selectedProvider && this._selectedModel) {
      this._persistDefaultModel();
    }
  }

  private async _persistDefaultModel() {
    this._savingModel = true;

    try {
      const body: DefaultModel = {
        provider: this._selectedProvider,
        modelId: this._selectedModel,
        thinkingLevel: this._selectedThinking,
      };

      const res = await fetch("/api/settings/default_model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed to save" }));
        showToast(data.error || "Failed to save default model", "error");
      } else {
        this._defaultModel = body;
        showToast("Default model updated", "success");
      }
    } catch {
      showToast("Failed to save default model", "error");
    } finally {
      this._savingModel = false;
    }
  }

  private async _clearDefaultModel() {
    this._savingModel = true;

    try {
      const res = await fetch("/api/settings/default_model", {
        method: "DELETE",
      });

      if (!res.ok) {
        showToast("Failed to clear default model", "error");
      } else {
        this._defaultModel = null;
        this._selectedProvider = "";
        this._selectedModel = "";
        this._selectedThinking = "high";
        showToast("Default model cleared", "success");
      }
    } catch {
      showToast("Failed to clear default model", "error");
    } finally {
      this._savingModel = false;
    }
  }

  // ---- Helpers --------------------------------------------------------------

  /** Get providers that have a key configured. */
  private get _availableProviders(): ProviderInfo[] {
    return this._providers.filter((p) => p.hasKey);
  }

  private _getModelsForProvider(providerName: string): ModelInfo[] {
    const provider = this._providers.find((prov) => prov.provider === providerName);
    return provider?.models ?? [];
  }

  private _isReasoningModel(): boolean {
    const models = this._getModelsForProvider(this._selectedProvider);
    const model = models.find((m) => m.id === this._selectedModel);
    return model?.reasoning ?? false;
  }

  private _handleBackdropClick(e: MouseEvent) {
    // Close when clicking the backdrop (the outer div), not inner content
    if (e.target === e.currentTarget) {
      this.close();
    }
  }

  // ---- Render ---------------------------------------------------------------

  private _renderApiKeyRow(keyState: ApiKeyState) {
    const isEnvOnly = keyState.keySource === "env";
    const hasDbKey = keyState.keySource === "db";

    return html`
      <div class="flex flex-col gap-1.5 py-2">
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium text-zinc-200 w-24">${keyState.label}</span>
          ${keyState.configured
            ? html`<span class="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Key configured"></span>`
            : html`<span class="w-2 h-2 rounded-full bg-zinc-600 shrink-0" title="No key configured"></span>`}
          ${isEnvOnly
            ? html`<span class="text-[10px] text-zinc-500 bg-zinc-700/50 px-1.5 py-0.5 rounded">via environment</span>`
            : nothing}
          ${hasDbKey
            ? html`
              <span class="text-[10px] text-green-400/70 bg-green-900/30 px-1.5 py-0.5 rounded">stored</span>
              <button
                class="text-[10px] text-red-400 hover:text-red-300 cursor-pointer transition-colors ml-auto"
                @click=${() => this._deleteApiKey(keyState.provider)}
                title="Remove stored key"
              >
                Remove
              </button>
            `
            : nothing}
        </div>
        <div class="flex items-center gap-2">
          <input
            type="password"
            placeholder=${hasDbKey ? "Enter new key to replace..." : "Enter API key..."}
            class="flex-1 px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100
                   placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors font-mono"
            .value=${keyState.inputValue}
            @input=${(e: InputEvent) => {
              if (e.target instanceof HTMLInputElement) {
                this._updateKeyInput(keyState.provider, e.target.value);
              }
            }}
            @keydown=${(e: KeyboardEvent) => this._handleKeyDown(e, keyState.provider)}
            @blur=${() => {
              if (keyState.inputValue.trim()) {
                this._saveApiKey(keyState.provider);
              }
            }}
            ?disabled=${keyState.saving}
          />
          ${keyState.inputValue.trim()
            ? html`
              <button
                class="px-2.5 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors disabled:opacity-50"
                @click=${() => this._saveApiKey(keyState.provider)}
                ?disabled=${keyState.saving}
              >${keyState.saving ? "Saving..." : "Save"}</button>
            `
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderDefaultModelSection() {
    const availableProviders = this._availableProviders;
    const models = this._getModelsForProvider(this._selectedProvider);
    const isReasoning = this._isReasoningModel();

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
        <!-- Provider -->
        <div>
          <label class="block text-[10px] text-zinc-400 mb-1">Provider</label>
          <select
            class=${selectClass}
            .value=${this._selectedProvider}
            @change=${this._handleProviderChange}
            ?disabled=${this._savingModel}
          >
            <option value="">Select a provider...</option>
            ${availableProviders.map(
              (p) =>
                html`<option value=${p.provider} ?selected=${p.provider === this._selectedProvider}>
                  ${p.provider}
                </option>`,
            )}
          </select>
        </div>

        <!-- Model -->
        ${this._selectedProvider
          ? html`
            <div>
              <label class="block text-[10px] text-zinc-400 mb-1">Model</label>
              <select
                class=${selectClass}
                .value=${this._selectedModel}
                @change=${this._handleModelChange}
                ?disabled=${this._savingModel}
              >
                <option value="">Select a model...</option>
                ${models.map(
                  (m) =>
                    html`<option value=${m.id} ?selected=${m.id === this._selectedModel}>
                      ${m.name}
                    </option>`,
                )}
              </select>
            </div>
          `
          : nothing}

        <!-- Thinking level (only for reasoning models) -->
        ${this._selectedModel && isReasoning
          ? html`
            <div>
              <label class="block text-[10px] text-zinc-400 mb-1">Thinking Level</label>
              <select
                class=${selectClass}
                .value=${this._selectedThinking}
                @change=${this._handleThinkingChange}
                ?disabled=${this._savingModel}
              >
                ${THINKING_LEVELS.map(
                  (t) =>
                    html`<option value=${t.value} ?selected=${t.value === this._selectedThinking}>
                      ${t.label}
                    </option>`,
                )}
              </select>
            </div>
          `
          : nothing}

        <!-- Current default display -->
        ${this._defaultModel
          ? html`
            <div class="flex items-center gap-2 pt-1">
              <span class="text-[10px] text-zinc-500">
                Current: ${this._defaultModel.provider} / ${this._defaultModel.modelId}
                ${this._defaultModel.thinkingLevel !== "high"
                  ? `(${this._defaultModel.thinkingLevel})`
                  : ""}
              </span>
              <button
                class="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors"
                @click=${this._clearDefaultModel}
              >Clear</button>
            </div>
          `
          : nothing}
      </div>
    `;
  }

  override render() {
    if (!this._open) return nothing;

    return html`
      <div
        class="fixed inset-0 z-[var(--layer-overlay)] bg-black/50 backdrop-blur-sm flex items-start justify-center pt-[10vh] overflow-y-auto"
        @click=${this._handleBackdropClick}
      >
        <div class="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl w-[calc(100vw-2rem)] max-w-lg p-5 mb-8">
          <!-- Header -->
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-sm font-medium text-zinc-200">Settings</h2>
            <button
              class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
              @click=${this.close}
              title="Close settings"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
              </svg>
            </button>
          </div>

          ${this._loading
            ? html`<div class="text-xs text-zinc-500 py-4 text-center">Loading settings...</div>`
            : html`
              <!-- API Keys Section -->
              <div class="mb-5">
                <h3 class="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">API Keys</h3>
                <div class="divide-y divide-zinc-700/50">
                  ${this._apiKeys.map((k) => this._renderApiKeyRow(k))}
                </div>
              </div>

              <!-- Default Model Section -->
              <div>
                <h3 class="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Default Model</h3>
                <p class="text-[10px] text-zinc-500 mb-3">New sessions will use this model. Existing sessions are not affected.</p>
                ${this._renderDefaultModelSection()}
              </div>
            `}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-panel": SettingsPanel;
  }
}
