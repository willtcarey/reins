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
  keySource: "db" | "env" | "oauth" | null;
  models: ModelInfo[];
}

interface OAuthProviderInfo {
  id: string;
  name: string;
  configured: boolean;
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
  /** Source of the active key */
  keySource: "db" | "env" | "oauth" | null;
}

/** Prettify a provider slug into a display label. */
function providerLabel(provider: string): string {
  return provider
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

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

  // OAuth providers
  @state() private _oauthProviders: OAuthProviderInfo[] = [];

  // "Add key" flow — selected provider + input value
  @state() private _addKeyProvider = "";
  @state() private _addKeyValue = "";
  @state() private _addKeySaving = false;

  // OAuth login flow state
  @state() private _oauthLoginProvider = "";
  @state() private _oauthAuthUrl = "";
  @state() private _oauthInstructions = "";
  @state() private _oauthCallbackValue = "";
  @state() private _oauthLoading = false;

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
      const [providersRes, defaultModelRes, settingsRes, oauthRes] = await Promise.all([
        fetch("/api/models"),
        fetch("/api/settings/default_model"),
        fetch("/api/settings"),
        fetch("/api/oauth/providers"),
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
      if (settingsRes.ok) {
        await settingsRes.json(); // consumed but not currently used beyond loading
      }

      // Parse OAuth providers
      if (oauthRes.ok) {
        this._oauthProviders = await oauthRes.json();
      }

      // Build API key states only for providers that have a key configured
      this._apiKeys = this._providers
        .filter((p) => p.hasKey)
        .map((providerInfo) => ({
          provider: providerInfo.provider,
          label: providerLabel(providerInfo.provider),
          keySource: providerInfo.keySource,
        }));

      // Reset add-key flow
      this._addKeyProvider = "";
      this._addKeyValue = "";
      this._addKeySaving = false;

      // Reset OAuth login flow
      this._oauthLoginProvider = "";
      this._oauthAuthUrl = "";
      this._oauthInstructions = "";
      this._oauthCallbackValue = "";
      this._oauthLoading = false;

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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Failed to load settings: ${msg}`, "error");
    } finally {
      this._loading = false;
    }
  }

  // ---- API Key handlers -----------------------------------------------------

  /** Providers that don't yet have a key configured (candidates for the "Add" dropdown). */
  private get _unconfiguredProviders(): ProviderInfo[] {
    return this._providers.filter((p) => !p.hasKey);
  }

  private async _saveNewApiKey() {
    const provider = this._addKeyProvider;
    const value = this._addKeyValue.trim();
    if (!provider || !value) return;

    this._addKeySaving = true;

    try {
      const res = await fetch(`/api/settings/api_key_${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const detail = data?.error ?? `HTTP ${res.status}`;
        showToast(`Failed to save API key: ${detail}`, "error");
      } else {
        showToast(`${providerLabel(provider)} API key saved`, "success");
        await this._loadData();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Failed to save API key: ${msg}`, "error");
    } finally {
      this._addKeySaving = false;
    }
  }

  private async _deleteApiKey(provider: string) {
    try {
      const res = await fetch(`/api/settings/api_key_${provider}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const detail = data?.error ?? `HTTP ${res.status}`;
        showToast(`Failed to remove API key: ${detail}`, "error");
      } else {
        showToast(`${providerLabel(provider)} API key removed`, "success");
        await this._loadData();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Failed to remove API key: ${msg}`, "error");
    }
  }

  private _handleAddKeyKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      this._saveNewApiKey();
    }
  }

  // ---- OAuth handlers -------------------------------------------------------

  /** Get OAuth providers that aren't already configured and aren't already shown as having a key. */
  private get _availableOAuthProviders(): OAuthProviderInfo[] {
    const configuredProviders = new Set(
      this._apiKeys.map((k) => k.provider),
    );
    return this._oauthProviders.filter(
      (p) => !p.configured && !configuredProviders.has(p.id),
    );
  }

  /** Check if a provider has an OAuth option available. */
  private _hasOAuthOption(provider: string): boolean {
    return this._oauthProviders.some((p) => p.id === provider);
  }

  private async _startOAuthLogin(providerId: string) {
    this._oauthLoading = true;
    this._oauthLoginProvider = providerId;
    this._oauthAuthUrl = "";
    this._oauthCallbackValue = "";

    try {
      const res = await fetch(`/api/oauth/start/${providerId}`, {
        method: "POST",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const detail = data?.error ?? `HTTP ${res.status}`;
        showToast(`Failed to start OAuth login: ${detail}`, "error");
        this._oauthLoginProvider = "";
        return;
      }

      const data = await res.json();
      this._oauthAuthUrl = data.url;
      this._oauthInstructions = data.instructions || "";
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Failed to start OAuth login: ${msg}`, "error");
      this._oauthLoginProvider = "";
    } finally {
      this._oauthLoading = false;
    }
  }

  private async _completeOAuthLogin() {
    const code = this._oauthCallbackValue.trim();
    if (!code || !this._oauthLoginProvider) return;

    this._oauthLoading = true;

    try {
      const res = await fetch(`/api/oauth/callback/${this._oauthLoginProvider}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const detail = data?.error ?? `HTTP ${res.status}`;
        showToast(`OAuth login failed: ${detail}`, "error");
      } else {
        showToast(
          `${providerLabel(this._oauthLoginProvider)} connected via OAuth`,
          "success",
        );
        await this._loadData();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`OAuth login failed: ${msg}`, "error");
    } finally {
      this._oauthLoading = false;
    }
  }

  private async _disconnectOAuth(providerId: string) {
    try {
      const res = await fetch(`/api/oauth/${providerId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const detail = data?.error ?? `HTTP ${res.status}`;
        showToast(`Failed to disconnect: ${detail}`, "error");
      } else {
        showToast(`${providerLabel(providerId)} disconnected`, "success");
        await this._loadData();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Failed to disconnect: ${msg}`, "error");
    }
  }

  private _handleOAuthCallbackKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      this._completeOAuthLogin();
    }
  }

  private _cancelOAuthLogin() {
    this._oauthLoginProvider = "";
    this._oauthAuthUrl = "";
    this._oauthInstructions = "";
    this._oauthCallbackValue = "";
    this._oauthLoading = false;
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
        const data = await res.json().catch(() => null);
        const detail = data?.error ?? `HTTP ${res.status}`;
        showToast(`Failed to save default model: ${detail}`, "error");
      } else {
        this._defaultModel = body;
        showToast("Default model updated", "success");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Failed to save default model: ${msg}`, "error");
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
        const data = await res.json().catch(() => null);
        const detail = data?.error ?? `HTTP ${res.status}`;
        showToast(`Failed to clear default model: ${detail}`, "error");
      } else {
        this._defaultModel = null;
        this._selectedProvider = "";
        this._selectedModel = "";
        this._selectedThinking = "high";
        showToast("Default model cleared", "success");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Failed to clear default model: ${msg}`, "error");
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

  /** Render a single configured API key row (compact, read-only). */
  private _renderConfiguredKey(keyState: ApiKeyState) {
    const isEnv = keyState.keySource === "env";
    const isDb = keyState.keySource === "db";
    const isOAuth = keyState.keySource === "oauth";

    return html`
      <div class="flex items-center gap-2 py-1.5">
        <span class="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Key configured"></span>
        <span class="text-xs font-medium text-zinc-200">${keyState.label}</span>
        ${isEnv
          ? html`<span class="text-[10px] text-zinc-500 bg-zinc-700/50 px-1.5 py-0.5 rounded">env</span>`
          : nothing}
        ${isDb
          ? html`
            <span class="text-[10px] text-green-400/70 bg-green-900/30 px-1.5 py-0.5 rounded">stored</span>
            <button
              class="text-[10px] text-red-400 hover:text-red-300 cursor-pointer transition-colors ml-auto"
              @click=${() => this._deleteApiKey(keyState.provider)}
              title="Remove stored key"
            >Remove</button>
          `
          : nothing}
        ${isOAuth
          ? html`
            <span class="text-[10px] text-blue-400/70 bg-blue-900/30 px-1.5 py-0.5 rounded">oauth</span>
            <button
              class="text-[10px] text-red-400 hover:text-red-300 cursor-pointer transition-colors ml-auto"
              @click=${() => this._disconnectOAuth(keyState.provider)}
              title="Disconnect OAuth"
            >Disconnect</button>
          `
          : nothing}
      </div>
    `;
  }

  /** Render the "Add API Key" dropdown + input row. */
  private _renderAddKeyRow() {
    const unconfigured = this._unconfiguredProviders;
    if (unconfigured.length === 0) return nothing;

    const selectClass =
      "px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 outline-none focus:border-blue-500 transition-colors cursor-pointer appearance-none";

    const hasOAuth = this._addKeyProvider && this._hasOAuthOption(this._addKeyProvider);

    return html`
      <div class="flex flex-col gap-2 pt-2">
        <div class="flex items-center gap-2">
          <select
            class="${selectClass} w-44 shrink-0"
            .value=${this._addKeyProvider}
            @change=${(e: Event) => {
              if (e.target instanceof HTMLSelectElement) {
                this._addKeyProvider = e.target.value;
                this._addKeyValue = "";
                this._cancelOAuthLogin();
              }
            }}
            ?disabled=${this._addKeySaving || this._oauthLoading}
          >
            <option value="">Add API key...</option>
            ${unconfigured.map(
              (p) => html`<option value=${p.provider}>${providerLabel(p.provider)}</option>`,
            )}
          </select>
        </div>
        ${this._addKeyProvider
          ? html`
            ${hasOAuth ? this._renderOAuthSignIn(this._addKeyProvider) : nothing}
            <div class="flex items-center gap-2">
              <input
                type="password"
                placeholder="Paste API key..."
                class="flex-1 px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100
                       placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors font-mono"
                .value=${this._addKeyValue}
                @input=${(e: InputEvent) => {
                  if (e.target instanceof HTMLInputElement) {
                    this._addKeyValue = e.target.value;
                  }
                }}
                @keydown=${this._handleAddKeyKeyDown}
                ?disabled=${this._addKeySaving}
              />
              <button
                class="px-2.5 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer
                       transition-colors disabled:opacity-50"
                @click=${this._saveNewApiKey}
                ?disabled=${this._addKeySaving || !this._addKeyValue.trim()}
              >${this._addKeySaving ? "Saving..." : "Save"}</button>
            </div>
          `
          : nothing}
      </div>
    `;
  }

  /** Render the OAuth sign-in flow for a specific provider. */
  private _renderOAuthSignIn(providerId: string) {
    // If we're not in an active OAuth login for this provider, show the sign-in button
    if (this._oauthLoginProvider !== providerId) {
      return html`
        <div class="flex items-center gap-2">
          <button
            class="px-2.5 py-1.5 text-xs text-zinc-100 bg-purple-600 hover:bg-purple-500 rounded cursor-pointer
                   transition-colors disabled:opacity-50"
            @click=${() => this._startOAuthLogin(providerId)}
            ?disabled=${this._oauthLoading}
          >
            ${this._oauthLoading ? "Starting..." : `Sign in with ${providerLabel(providerId)}`}
          </button>
          <span class="text-[10px] text-zinc-500">or paste an API key below</span>
        </div>
      `;
    }

    // Active OAuth login — show auth URL and callback input
    return html`
      <div class="flex flex-col gap-2 p-2.5 bg-zinc-700/50 border border-zinc-600 rounded">
        ${this._oauthAuthUrl
          ? html`
            <div class="flex flex-col gap-1.5">
              <span class="text-[10px] text-zinc-400">1. Open this link to sign in:</span>
              <a
                href=${this._oauthAuthUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs text-blue-400 hover:text-blue-300 break-all underline"
              >${this._oauthAuthUrl.length > 80 ? this._oauthAuthUrl.slice(0, 80) + "..." : this._oauthAuthUrl}</a>
              <p class="text-[10px] text-zinc-500 leading-relaxed">
                ${this._oauthInstructions || "After signing in, your browser will try to redirect to localhost which will fail. Copy the URL from your browser's address bar and paste it below."}
              </p>
              <span class="text-[10px] text-zinc-400 mt-1">2. Paste the redirect URL:</span>
              <div class="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Paste the redirect URL here..."
                  class="flex-1 px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100
                         placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors font-mono"
                  .value=${this._oauthCallbackValue}
                  @input=${(e: InputEvent) => {
                    if (e.target instanceof HTMLInputElement) {
                      this._oauthCallbackValue = e.target.value;
                    }
                  }}
                  @keydown=${this._handleOAuthCallbackKeyDown}
                  ?disabled=${this._oauthLoading}
                />
                <button
                  class="px-2.5 py-1.5 text-xs text-zinc-100 bg-purple-600 hover:bg-purple-500 rounded cursor-pointer
                         transition-colors disabled:opacity-50 shrink-0"
                  @click=${this._completeOAuthLogin}
                  ?disabled=${this._oauthLoading || !this._oauthCallbackValue.trim()}
                >${this._oauthLoading ? "Connecting..." : "Connect"}</button>
              </div>
            </div>
          `
          : html`<span class="text-[10px] text-zinc-400">Starting OAuth flow...</span>`}
        <button
          class="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors self-start"
          @click=${this._cancelOAuthLogin}
        >Cancel</button>
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
                ${this._apiKeys.length > 0
                  ? html`
                    <div class="divide-y divide-zinc-700/50">
                      ${this._apiKeys.map((k) => this._renderConfiguredKey(k))}
                    </div>
                  `
                  : html`<p class="text-[10px] text-zinc-500 py-1">No API keys configured.</p>`}
                ${this._renderAddKeyRow()}
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
