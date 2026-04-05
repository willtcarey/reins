/**
 * Settings Store
 *
 * Owns all server-backed state for the settings panel: available providers,
 * OAuth provider metadata, default model selection, and API key mutations.
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

export interface DefaultModel {
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

export class SettingsStore {
  // ---- Public reactive state ------------------------------------------------

  loading = false;
  apiKeySaving = false;
  oauthLoading = false;
  savingModel = false;

  providers: ProviderInfo[] = [];
  oauthProviders: OAuthProviderInfo[] = [];
  defaultModel: DefaultModel | null = null;

  selectedProvider = "";
  selectedModel = "";
  selectedThinking = "high";

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

  isSelectedModelReasoning(): boolean {
    const model = this.getModelsForProvider(this.selectedProvider)
      .find((candidate) => candidate.id === this.selectedModel);
    return model?.reasoning ?? false;
  }

  // ---- Data loading ---------------------------------------------------------

  async load(): Promise<SettingsStoreResult> {
    this.loading = true;
    this.notify();

    try {
      const [providersRes, defaultModelRes, oauthRes] = await Promise.all([
        fetch("/api/models"),
        fetch("/api/settings/default_model"),
        fetch("/api/oauth/providers"),
      ]);

      if (providersRes.ok) {
        this.providers = await providersRes.json();
      }

      if (defaultModelRes.ok) {
        const data = await defaultModelRes.json();
        this.defaultModel = data.value ?? null;
      } else {
        this.defaultModel = null;
      }

      if (oauthRes.ok) {
        this.oauthProviders = await oauthRes.json();
      }

      this._resetOAuthLoginState();
      this._syncSelectionFromDefault();

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
      const res = await fetch(`/api/settings/api_key_${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
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
      const res = await fetch(`/api/settings/api_key_${provider}`, {
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
    this.selectedProvider = provider;

    const providerModels = this.getModelsForProvider(provider);
    this.selectedModel = providerModels[0]?.id ?? "";
    this.selectedThinking = "high";
    this.notify();

    if (!this.selectedProvider || !this.selectedModel) {
      return { ok: true };
    }

    return this._persistDefaultModel();
  }

  async selectModel(modelId: string): Promise<SettingsStoreResult> {
    this.selectedModel = modelId;
    this.notify();

    if (!this.selectedProvider || !this.selectedModel) {
      return { ok: true };
    }

    return this._persistDefaultModel();
  }

  async selectDefaultModel(provider: string, modelId: string): Promise<SettingsStoreResult> {
    const providerChanged = this.selectedProvider !== provider;

    this.selectedProvider = provider;
    this.selectedModel = modelId;
    if (providerChanged) {
      this.selectedThinking = "high";
    }
    this.notify();

    if (!this.selectedProvider || !this.selectedModel) {
      return { ok: true };
    }

    return this._persistDefaultModel();
  }

  async selectThinkingLevel(thinkingLevel: string): Promise<SettingsStoreResult> {
    this.selectedThinking = thinkingLevel;
    this.notify();

    if (!this.selectedProvider || !this.selectedModel) {
      return { ok: true };
    }

    return this._persistDefaultModel();
  }

  async clearDefaultModel(): Promise<SettingsStoreResult> {
    this.savingModel = true;
    this.notify();

    try {
      const res = await fetch("/api/settings/default_model", {
        method: "DELETE",
      });

      if (!res.ok) {
        return { error: await errorDetail(res) };
      }

      this.defaultModel = null;
      this.selectedProvider = "";
      this.selectedModel = "";
      this.selectedThinking = "high";
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.savingModel = false;
      this.notify();
    }
  }

  private async _persistDefaultModel(): Promise<SettingsStoreResult> {
    this.savingModel = true;
    this.notify();

    try {
      const body: DefaultModel = {
        provider: this.selectedProvider,
        modelId: this.selectedModel,
        thinkingLevel: this.selectedThinking,
      };

      const res = await fetch("/api/settings/default_model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        return { error: await errorDetail(res) };
      }

      this.defaultModel = body;
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.savingModel = false;
      this.notify();
    }
  }

  private _syncSelectionFromDefault() {
    if (this.defaultModel) {
      this.selectedProvider = this.defaultModel.provider;
      this.selectedModel = this.defaultModel.modelId;
      this.selectedThinking = this.defaultModel.thinkingLevel;
      return;
    }

    this.selectedProvider = "";
    this.selectedModel = "";
    this.selectedThinking = "high";
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
