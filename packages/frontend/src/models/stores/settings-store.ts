/**
 * Settings Store
 *
 * Owns all server-backed state for the settings panel: available providers,
 * OAuth provider metadata, model selections, and API key mutations.
 * Components render from public fields and call async store actions.
 */

import { providerLabel } from "../settings.js";

export interface ProviderInfo {
  provider: string;
  hasKey: boolean;
  keySource: "db" | "env" | "oauth" | null;
  keySources: ("db" | "env" | "oauth")[];
  models: ModelInfo[];
}

export interface OAuthProviderInfo {
  id: string;
  name: string;
  configured: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
}

export interface ModelSetting {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export interface ApiKeyState {
  provider: string;
  label: string;
  keySource: "db" | "env" | "oauth" | null;
  keySources: ("db" | "env" | "oauth")[];
}

export type SettingsStoreResult = { ok: true } | { error: string };
export type SettingsStoreListener = () => void;
export type ModelSettingKey = "default_model" | "utility_model";

export class SettingsStore {
  // ---- Public reactive state ------------------------------------------------

  loading = false;
  apiKeySaving = false;
  oauthLoading = false;
  savingModel = false;

  providers: ProviderInfo[] = [];
  oauthProviders: OAuthProviderInfo[] = [];
  defaultModel: ModelSetting | null = null;
  utilityModel: ModelSetting | null = null;

  selectedProvider = "";
  selectedModel = "";
  selectedThinking = "high";

  selectedUtilityProvider = "";
  selectedUtilityModel = "";
  selectedUtilityThinking = "minimal";

  oauthLoginProvider = "";
  oauthAuthUrl = "";
  oauthInstructions = "";

  // ---- Subscription ---------------------------------------------------------

  private _listeners = new Set<SettingsStoreListener>();

  subscribe(fn: SettingsStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  // ---- Derived state --------------------------------------------------------

  get apiKeys(): ApiKeyState[] {
    return this.providers
      .filter((providerInfo) => providerInfo.hasKey)
      .map((providerInfo) => ({
        provider: providerInfo.provider,
        label: providerLabel(providerInfo.provider),
        keySource: providerInfo.keySource,
        keySources: providerInfo.keySources ?? (providerInfo.keySource ? [providerInfo.keySource] : []),
      }));
  }

  get unconfiguredProviders(): ProviderInfo[] {
    return this.providers.filter((provider) => !provider.hasKey);
  }

  get availableOAuthProviders(): OAuthProviderInfo[] {
    const configuredProviders = new Set(this.apiKeys.map((key) => key.provider));
    return this.oauthProviders.filter(
      (provider) => !provider.configured && !configuredProviders.has(provider.id),
    );
  }

  get availableProviders(): ProviderInfo[] {
    return this.providers.filter((provider) => provider.hasKey);
  }

  getModelsForProvider(providerName: string): ModelInfo[] {
    return this.providers.find((provider) => provider.provider === providerName)?.models ?? [];
  }

  hasOAuthOption(provider: string): boolean {
    return this.oauthProviders.some((oauthProvider) => oauthProvider.id === provider);
  }

  isSelectedModelReasoning(settingKey: ModelSettingKey = "default_model"): boolean {
    const provider = this._selectedProviderFor(settingKey);
    const modelId = this._selectedModelFor(settingKey);
    const model = this.getModelsForProvider(provider)
      .find((candidate) => candidate.id === modelId);
    return model?.reasoning ?? false;
  }

  // ---- Data loading ---------------------------------------------------------

  async load(): Promise<SettingsStoreResult> {
    this.loading = true;
    this.notify();

    try {
      const [providersRes, defaultModelRes, utilityModelRes, oauthRes] = await Promise.all([
        fetch("/api/models"),
        fetch("/api/settings/default_model"),
        fetch("/api/settings/utility_model"),
        fetch("/api/oauth/providers"),
      ]);

      if (providersRes.ok) {
        this.providers = await providersRes.json();
      }

      this.defaultModel = await this._readModelSettingResponse(defaultModelRes);
      this.utilityModel = await this._readModelSettingResponse(utilityModelRes);

      if (oauthRes.ok) {
        this.oauthProviders = await oauthRes.json();
      }

      this._resetOAuthLoginState();
      this._syncSelectionFromSettings();

      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.loading = false;
      this.notify();
    }
  }

  // ---- API keys -------------------------------------------------------------

  async saveApiKey(provider: string, value: string): Promise<SettingsStoreResult> {
    this.apiKeySaving = true;
    this.notify();

    try {
      const res = await fetch(`/api/auth/api-keys/${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: value }),
      });

      if (!res.ok) {
        return { error: await errorDetail(res) };
      }

      return await this.load();
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.apiKeySaving = false;
      this.notify();
    }
  }

  async deleteApiKey(provider: string): Promise<SettingsStoreResult> {
    this.apiKeySaving = true;
    this.notify();

    try {
      const res = await fetch(`/api/auth/api-keys/${provider}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        return { error: await errorDetail(res) };
      }

      return await this.load();
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.apiKeySaving = false;
      this.notify();
    }
  }

  // ---- OAuth ----------------------------------------------------------------

  async startOAuthLogin(providerId: string): Promise<SettingsStoreResult> {
    this.oauthLoading = true;
    this.oauthLoginProvider = providerId;
    this.oauthAuthUrl = "";
    this.oauthInstructions = "";
    this.notify();

    try {
      const res = await fetch(`/api/oauth/start/${providerId}`, {
        method: "POST",
      });

      if (!res.ok) {
        this._resetOAuthLoginState();
        return { error: await errorDetail(res) };
      }

      const data = await res.json();
      this.oauthAuthUrl = data.url;
      this.oauthInstructions = data.instructions || "";
      return { ok: true };
    } catch (err: unknown) {
      this._resetOAuthLoginState();
      return { error: errorMessage(err) };
    } finally {
      this.oauthLoading = false;
      this.notify();
    }
  }

  async completeOAuthLogin(code: string): Promise<SettingsStoreResult> {
    if (!code.trim() || !this.oauthLoginProvider) {
      return { error: "Missing OAuth callback URL" };
    }

    this.oauthLoading = true;
    this.notify();

    try {
      const res = await fetch(`/api/oauth/callback/${this.oauthLoginProvider}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      if (!res.ok) {
        return { error: await errorDetail(res) };
      }

      return await this.load();
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.oauthLoading = false;
      this.notify();
    }
  }

  async disconnectOAuth(providerId: string): Promise<SettingsStoreResult> {
    this.oauthLoading = true;
    this.notify();

    try {
      const res = await fetch(`/api/oauth/${providerId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        return { error: await errorDetail(res) };
      }

      return await this.load();
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.oauthLoading = false;
      this.notify();
    }
  }

  cancelOAuthLogin() {
    this._resetOAuthLoginState();
    this.notify();
  }

  // ---- Default model --------------------------------------------------------

  async selectProvider(provider: string): Promise<SettingsStoreResult> {
    return this.selectModelSettingProvider("default_model", provider);
  }

  async selectModel(modelId: string): Promise<SettingsStoreResult> {
    return this.selectModelSettingModel("default_model", modelId);
  }

  async selectDefaultModel(provider: string, modelId: string): Promise<SettingsStoreResult> {
    return this.selectModelSetting("default_model", provider, modelId);
  }

  async selectThinkingLevel(thinkingLevel: string): Promise<SettingsStoreResult> {
    return this.selectModelSettingThinkingLevel("default_model", thinkingLevel);
  }

  async clearDefaultModel(): Promise<SettingsStoreResult> {
    return this.clearModelSetting("default_model");
  }

  // ---- Utility model --------------------------------------------------------

  async selectUtilityModel(provider: string, modelId: string): Promise<SettingsStoreResult> {
    return this.selectModelSetting("utility_model", provider, modelId);
  }

  async selectUtilityThinkingLevel(thinkingLevel: string): Promise<SettingsStoreResult> {
    return this.selectModelSettingThinkingLevel("utility_model", thinkingLevel);
  }

  async clearUtilityModel(): Promise<SettingsStoreResult> {
    return this.clearModelSetting("utility_model");
  }

  // ---- Shared model-setting helpers ----------------------------------------

  async selectModelSettingProvider(settingKey: ModelSettingKey, provider: string): Promise<SettingsStoreResult> {
    this._setSelectedProvider(settingKey, provider);

    const providerModels = this.getModelsForProvider(provider);
    this._setSelectedModel(settingKey, providerModels[0]?.id ?? "");
    this._setSelectedThinking(settingKey, this._defaultThinkingLevel(settingKey));
    this.notify();

    if (!this._selectedProviderFor(settingKey) || !this._selectedModelFor(settingKey)) {
      return { ok: true };
    }

    return this._persistModelSetting(settingKey);
  }

  async selectModelSettingModel(settingKey: ModelSettingKey, modelId: string): Promise<SettingsStoreResult> {
    this._setSelectedModel(settingKey, modelId);
    this.notify();

    if (!this._selectedProviderFor(settingKey) || !this._selectedModelFor(settingKey)) {
      return { ok: true };
    }

    return this._persistModelSetting(settingKey);
  }

  async selectModelSetting(settingKey: ModelSettingKey, provider: string, modelId: string): Promise<SettingsStoreResult> {
    const providerChanged = this._selectedProviderFor(settingKey) !== provider;

    this._setSelectedProvider(settingKey, provider);
    this._setSelectedModel(settingKey, modelId);
    if (providerChanged) {
      this._setSelectedThinking(settingKey, this._defaultThinkingLevel(settingKey));
    }
    this.notify();

    if (!this._selectedProviderFor(settingKey) || !this._selectedModelFor(settingKey)) {
      return { ok: true };
    }

    return this._persistModelSetting(settingKey);
  }

  async selectModelSettingThinkingLevel(settingKey: ModelSettingKey, thinkingLevel: string): Promise<SettingsStoreResult> {
    this._setSelectedThinking(settingKey, thinkingLevel);
    this.notify();

    if (!this._selectedProviderFor(settingKey) || !this._selectedModelFor(settingKey)) {
      return { ok: true };
    }

    return this._persistModelSetting(settingKey);
  }

  async clearModelSetting(settingKey: ModelSettingKey): Promise<SettingsStoreResult> {
    this.savingModel = true;
    this.notify();

    try {
      const res = await fetch(`/api/settings/${settingKey}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        return { error: await errorDetail(res) };
      }

      this._setStoredModel(settingKey, null);
      this._setSelectedProvider(settingKey, "");
      this._setSelectedModel(settingKey, "");
      this._setSelectedThinking(settingKey, this._defaultThinkingLevel(settingKey));
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.savingModel = false;
      this.notify();
    }
  }

  private async _persistModelSetting(settingKey: ModelSettingKey): Promise<SettingsStoreResult> {
    this.savingModel = true;
    this.notify();

    try {
      const body: ModelSetting = {
        provider: this._selectedProviderFor(settingKey),
        modelId: this._selectedModelFor(settingKey),
        thinkingLevel: this._selectedThinkingFor(settingKey),
      };

      const res = await fetch(`/api/settings/${settingKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        return { error: await errorDetail(res) };
      }

      this._setStoredModel(settingKey, body);
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.savingModel = false;
      this.notify();
    }
  }

  private async _readModelSettingResponse(response: Response): Promise<ModelSetting | null> {
    if (!response.ok) return null;
    const data = await response.json();
    return data.value ?? null;
  }

  private _syncSelectionFromSettings() {
    this._syncSelectionFromSetting("default_model");
    this._syncSelectionFromSetting("utility_model");
  }

  private _syncSelectionFromSetting(settingKey: ModelSettingKey) {
    const model = this._storedModelFor(settingKey);
    if (model) {
      this._setSelectedProvider(settingKey, model.provider);
      this._setSelectedModel(settingKey, model.modelId);
      this._setSelectedThinking(settingKey, model.thinkingLevel);
      return;
    }

    this._setSelectedProvider(settingKey, "");
    this._setSelectedModel(settingKey, "");
    this._setSelectedThinking(settingKey, this._defaultThinkingLevel(settingKey));
  }

  private _storedModelFor(settingKey: ModelSettingKey): ModelSetting | null {
    return settingKey === "default_model" ? this.defaultModel : this.utilityModel;
  }

  private _setStoredModel(settingKey: ModelSettingKey, model: ModelSetting | null) {
    if (settingKey === "default_model") {
      this.defaultModel = model;
      return;
    }

    this.utilityModel = model;
  }

  private _selectedProviderFor(settingKey: ModelSettingKey): string {
    return settingKey === "default_model" ? this.selectedProvider : this.selectedUtilityProvider;
  }

  private _setSelectedProvider(settingKey: ModelSettingKey, provider: string) {
    if (settingKey === "default_model") {
      this.selectedProvider = provider;
      return;
    }

    this.selectedUtilityProvider = provider;
  }

  private _selectedModelFor(settingKey: ModelSettingKey): string {
    return settingKey === "default_model" ? this.selectedModel : this.selectedUtilityModel;
  }

  private _setSelectedModel(settingKey: ModelSettingKey, modelId: string) {
    if (settingKey === "default_model") {
      this.selectedModel = modelId;
      return;
    }

    this.selectedUtilityModel = modelId;
  }

  private _selectedThinkingFor(settingKey: ModelSettingKey): string {
    return settingKey === "default_model" ? this.selectedThinking : this.selectedUtilityThinking;
  }

  private _setSelectedThinking(settingKey: ModelSettingKey, thinkingLevel: string) {
    if (settingKey === "default_model") {
      this.selectedThinking = thinkingLevel;
      return;
    }

    this.selectedUtilityThinking = thinkingLevel;
  }

  private _defaultThinkingLevel(settingKey: ModelSettingKey): string {
    return settingKey === "default_model" ? "high" : "minimal";
  }

  private _resetOAuthLoginState() {
    this.oauthLoginProvider = "";
    this.oauthAuthUrl = "";
    this.oauthInstructions = "";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function errorDetail(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return body?.error ?? `HTTP ${response.status}`;
}
