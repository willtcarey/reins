import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { providerLabel } from "../../models/settings.js";
import { ModelRegistryStore, type ApiKeyState } from "../../models/stores/model-registry-store.js";
import { SettingsStore } from "../../models/stores/settings-store.js";
import { showToast } from "../toast.js";

@customElement("settings-api-keys-section")
export class SettingsApiKeysSection extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _storeCtrl = new StoreController<SettingsStore>(this);
  private _registryStoreCtrl = new StoreController<ModelRegistryStore>(this);

  @property({ attribute: false })
  set store(store: SettingsStore | null) {
    this._storeCtrl.store = store;
  }

  get store(): SettingsStore | null {
    return this._storeCtrl.store;
  }

  @property({ attribute: false })
  set registryStore(store: ModelRegistryStore | null) {
    this._registryStoreCtrl.store = store;
  }

  get registryStore(): ModelRegistryStore | null {
    return this._registryStoreCtrl.store;
  }

  @state() private _addKeyProvider = "";
  @state() private _addKeyValue = "";
  @state() private _oauthCallbackValue = "";

  private _resetLocalState() {
    this._addKeyProvider = "";
    this._addKeyValue = "";
    this._oauthCallbackValue = "";
  }

  private async _reloadRegistry(): Promise<boolean> {
    const result = await this.registryStore?.load();
    if (result && "error" in result) {
      showToast(`Failed to refresh model registry: ${result.error}`, "error");
      return false;
    }

    return true;
  }

  private async _saveNewApiKey() {
    const store = this.store;
    const provider = this._addKeyProvider;
    const value = this._addKeyValue.trim();
    if (!store || !provider || !value) return;

    const result = await store.saveApiKey(provider, value);
    if ("error" in result) {
      showToast(`Failed to save API key: ${result.error}`, "error");
      return;
    }

    await this._reloadRegistry();
    this._resetLocalState();
    showToast(`${providerLabel(provider)} API key saved`, "success");
  }

  private async _deleteApiKey(provider: string) {
    const store = this.store;
    if (!store) return;

    const result = await store.deleteApiKey(provider);
    if ("error" in result) {
      showToast(`Failed to remove API key: ${result.error}`, "error");
      return;
    }

    await this._reloadRegistry();
    this._resetLocalState();
    showToast(`${providerLabel(provider)} API key removed`, "success");
  }

  private _handleAddKeyKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void this._saveNewApiKey();
    }
  }

  private async _startOAuthLogin(providerId: string) {
    const store = this.store;
    if (!store) return;

    const result = await store.startOAuthLogin(providerId);
    if ("error" in result) {
      showToast(`Failed to start OAuth login: ${result.error}`, "error");
    }
  }

  private async _completeOAuthLogin() {
    const store = this.store;
    const code = this._oauthCallbackValue.trim();
    if (!store || !code || !store.oauthLoginProvider) return;

    const providerId = store.oauthLoginProvider;
    const result = await store.completeOAuthLogin(code);
    if ("error" in result) {
      showToast(`OAuth login failed: ${result.error}`, "error");
      return;
    }

    await this._reloadRegistry();
    this._resetLocalState();
    showToast(`${providerLabel(providerId)} connected via OAuth`, "success");
  }

  private async _disconnectOAuth(providerId: string) {
    const store = this.store;
    if (!store) return;

    const result = await store.disconnectOAuth(providerId);
    if ("error" in result) {
      showToast(`Failed to disconnect: ${result.error}`, "error");
      return;
    }

    await this._reloadRegistry();
    this._resetLocalState();
    showToast(`${providerLabel(providerId)} disconnected`, "success");
  }

  private _handleOAuthCallbackKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void this._completeOAuthLogin();
    }
  }

  private _cancelOAuthLogin() {
    this._oauthCallbackValue = "";
    this.store?.cancelOAuthLogin();
  }

  private _selectAddKeyProvider(provider: string) {
    const store = this.store;
    this._addKeyProvider = provider;
    this._addKeyValue = "";
    this._oauthCallbackValue = "";
    store?.cancelOAuthLogin();
  }

  private _renderConfiguredKey(keyState: ApiKeyState) {
    const sources = keyState.keySources;
    const hasEnv = sources.includes("env");
    const hasDb = sources.includes("db");
    const hasOAuth = sources.includes("oauth");

    return html`
      <div class="flex items-center gap-2 py-1.5">
        <span class="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Key configured"></span>
        <span class="text-xs font-medium text-zinc-200">${keyState.label}</span>
        ${hasEnv
          ? html`<span class="text-[10px] text-zinc-500 bg-zinc-700/50 px-1.5 py-0.5 rounded">env</span>`
          : nothing}
        ${hasDb
          ? html`<span class="text-[10px] text-green-400/70 bg-green-900/30 px-1.5 py-0.5 rounded">stored</span>`
          : nothing}
        ${hasOAuth
          ? html`<span class="text-[10px] text-blue-400/70 bg-blue-900/30 px-1.5 py-0.5 rounded">oauth</span>`
          : nothing}
        <span class="ml-auto flex items-center gap-2">
          ${hasDb
            ? html`<button
                class="text-[10px] text-red-400 hover:text-red-300 cursor-pointer transition-colors"
                @click=${() => void this._deleteApiKey(keyState.provider)}
                title="Remove stored key"
              >Remove key</button>`
            : nothing}
          ${hasOAuth
            ? html`<button
                class="text-[10px] text-red-400 hover:text-red-300 cursor-pointer transition-colors"
                @click=${() => void this._disconnectOAuth(keyState.provider)}
                title="Disconnect OAuth"
              >Disconnect</button>`
            : nothing}
        </span>
      </div>
    `;
  }

  private _renderOAuthSignIn(providerId: string) {
    const store = this.store;
    if (!store) return nothing;

    if (store.oauthLoginProvider !== providerId) {
      return html`
        <div class="flex items-center gap-2">
          <button
            class="px-2.5 py-1.5 text-xs text-zinc-100 bg-purple-600 hover:bg-purple-500 rounded cursor-pointer
                   transition-colors disabled:opacity-50"
            @click=${() => void this._startOAuthLogin(providerId)}
            ?disabled=${store.oauthLoading}
          >
            ${store.oauthLoading ? "Starting..." : `Sign in with ${providerLabel(providerId)}`}
          </button>
          <span class="text-[10px] text-zinc-500">or paste an API key below</span>
        </div>
      `;
    }

    return html`
      <div class="flex flex-col gap-2 p-2.5 bg-zinc-700/50 border border-zinc-600 rounded">
        ${store.oauthAuthUrl
          ? html`
            <div class="flex flex-col gap-1.5">
              <span class="text-[10px] text-zinc-400">1. Open this link to sign in:</span>
              <a
                href=${store.oauthAuthUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs text-blue-400 hover:text-blue-300 break-all underline"
              >${store.oauthAuthUrl.length > 80
                ? store.oauthAuthUrl.slice(0, 80) + "..."
                : store.oauthAuthUrl}</a>
              <p class="text-[10px] text-zinc-500 leading-relaxed">
                ${store.oauthInstructions
                  || "After signing in, your browser will try to redirect to localhost which will fail. Copy the URL from your browser's address bar and paste it below."}
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
                  ?disabled=${store.oauthLoading}
                />
                <button
                  class="px-2.5 py-1.5 text-xs text-zinc-100 bg-purple-600 hover:bg-purple-500 rounded cursor-pointer
                         transition-colors disabled:opacity-50 shrink-0"
                  @click=${() => void this._completeOAuthLogin()}
                  ?disabled=${store.oauthLoading || !this._oauthCallbackValue.trim()}
                >${store.oauthLoading ? "Connecting..." : "Connect"}</button>
              </div>
            </div>
          `
          : html`<span class="text-[10px] text-zinc-400">Starting OAuth flow...</span>`}
        <button
          class="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors self-start"
          @click=${() => this._cancelOAuthLogin()}
        >Cancel</button>
      </div>
    `;
  }

  private _renderAddProviderTrigger() {
    const store = this.store;
    const registryStore = this.registryStore;
    if (!store || !registryStore) return nothing;

    const unconfigured = registryStore.unconfiguredProviders;
    if (unconfigured.length === 0) return nothing;

    return html`
      <div class="relative shrink-0">
        <button
          type="button"
          class="w-6 h-6 rounded border border-zinc-600 text-sm leading-none text-zinc-300 hover:text-zinc-100
                 hover:border-zinc-500 cursor-pointer transition-colors disabled:opacity-50"
          aria-label="Add new provider"
          title="Add new provider"
          ?disabled=${store.apiKeySaving || store.oauthLoading}
        >+</button>
        <select
          aria-label="Add new provider"
          title="Add new provider"
          class="absolute inset-0 opacity-0 cursor-pointer disabled:cursor-default"
          .value=${this._addKeyProvider}
          @change=${(e: Event) => {
            if (e.target instanceof HTMLSelectElement) {
              this._selectAddKeyProvider(e.target.value);
            }
          }}
          ?disabled=${store.apiKeySaving || store.oauthLoading}
        >
          <option value="">Add provider...</option>
          ${unconfigured.map(
            (provider) => html`<option value=${provider.provider}>${providerLabel(provider.provider)}</option>`,
          )}
        </select>
      </div>
    `;
  }

  private _renderAddKeyRow() {
    const store = this.store;
    if (!store || !this._addKeyProvider) return nothing;

    const hasOAuth = store.hasOAuthOption(this._addKeyProvider);

    return html`
      <div class="flex flex-col gap-2 pt-1">
        <div class="flex items-center gap-2">
          <span class="px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 shrink-0">
            ${providerLabel(this._addKeyProvider)}
          </span>
        </div>
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
            ?disabled=${store.apiKeySaving}
          />
          <button
            class="px-2.5 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer
                   transition-colors disabled:opacity-50"
            @click=${() => void this._saveNewApiKey()}
            ?disabled=${store.apiKeySaving || !this._addKeyValue.trim()}
          >${store.apiKeySaving ? "Saving..." : "Save"}</button>
        </div>
      </div>
    `;
  }

  override render() {
    const store = this.store;
    const registryStore = this.registryStore;
    if (!store || !registryStore) return nothing;

    return html`
      <div class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-xs font-medium text-zinc-400 uppercase tracking-wider">API Keys</h3>
          ${this._renderAddProviderTrigger()}
        </div>
        ${registryStore.apiKeys.length > 0
          ? html`
            <div class="divide-y divide-zinc-700/50">
              ${registryStore.apiKeys.map((key) => this._renderConfiguredKey(key))}
            </div>
          `
          : html`<p class="text-[10px] text-zinc-500 py-1">No API keys configured.</p>`}
        ${this._renderAddKeyRow()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-api-keys-section": SettingsApiKeysSection;
  }
}
