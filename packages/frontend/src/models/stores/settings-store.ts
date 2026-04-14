/**
 * Settings Store
 *
 * Owns server-backed state for settings values, OAuth provider metadata,
 * and settings-related mutations. Model/provider registry data lives in
 * ModelRegistryStore.
 */

export interface OAuthProviderInfo {
  id: string;
  name: string;
  configured: boolean;
}

export interface ModelSetting {
  provider: string;
  modelId: string;
  runtimeType: string;
  thinkingLevel: string;
}

export type SettingsStoreResult = { ok: true } | { error: string };
export type SettingsStoreListener = () => void;
export type ModelSettingKey = "default_model" | "utility_model";

type ModelSelection = {
  provider: string;
  modelId: string;
  runtimeType: string;
  thinkingLevel: string;
};

type ModelSettingState = {
  stored: ModelSetting | null;
  selected: ModelSelection;
};

const MODEL_SETTING_KEYS: ModelSettingKey[] = ["default_model", "utility_model"];

const MODEL_SETTING_DEFAULTS: Record<ModelSettingKey, ModelSelection> = {
  default_model: {
    provider: "",
    modelId: "",
    runtimeType: "",
    thinkingLevel: "high",
  },
  utility_model: {
    provider: "",
    modelId: "",
    runtimeType: "",
    thinkingLevel: "minimal",
  },
};

export class SettingsStore {
  loading = false;
  apiKeySaving = false;
  oauthLoading = false;
  savingModel = false;

  oauthProviders: OAuthProviderInfo[] = [];

  oauthLoginProvider = "";
  oauthAuthUrl = "";
  oauthInstructions = "";

  private _modelSettings: Record<ModelSettingKey, ModelSettingState> = {
    default_model: {
      stored: null,
      selected: { ...MODEL_SETTING_DEFAULTS.default_model },
    },
    utility_model: {
      stored: null,
      selected: { ...MODEL_SETTING_DEFAULTS.utility_model },
    },
  };

  private _listeners = new Set<SettingsStoreListener>();

  subscribe(fn: SettingsStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  get defaultModel(): ModelSetting | null {
    return this.getStoredModelSetting("default_model");
  }

  get utilityModel(): ModelSetting | null {
    return this.getStoredModelSetting("utility_model");
  }

  getStoredModelSetting(settingKey: ModelSettingKey): ModelSetting | null {
    return this._modelSettings[settingKey].stored;
  }

  getSelectedModelSetting(settingKey: ModelSettingKey): ModelSelection {
    return this._modelSettings[settingKey].selected;
  }

  hasOAuthOption(provider: string): boolean {
    return this.oauthProviders.some((oauthProvider) => oauthProvider.id === provider);
  }

  async load(settingKeys: ModelSettingKey[] = ["default_model", "utility_model"]): Promise<SettingsStoreResult> {
    this.loading = true;
    this.notify();

    try {
      const settingsQuery = settingKeys.map((key) => `key=${encodeURIComponent(key)}`).join("&");
      const [settingsRes, oauthRes] = await Promise.all([
        fetch(`/api/settings?${settingsQuery}`),
        fetch("/api/oauth/providers"),
      ]);

      if (!settingsRes.ok) {
        return { error: await errorDetail(settingsRes) };
      }
      this._applyLoadedModelSettings(await settingsRes.json());

      if (!oauthRes.ok) {
        return { error: await errorDetail(oauthRes) };
      }
      this.oauthProviders = await oauthRes.json();

      this._resetOAuthLoginState();
      this._syncSelectionsFromSettings(settingKeys);

      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.loading = false;
      this.notify();
    }
  }

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

      return { ok: true };
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

      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.apiKeySaving = false;
      this.notify();
    }
  }

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

  async selectModelSetting(
    settingKey: ModelSettingKey,
    provider: string,
    modelId: string,
    runtimeType: string,
  ): Promise<SettingsStoreResult> {
    const selection = this.getSelectedModelSetting(settingKey);
    this._setSelectedModelSetting(settingKey, {
      provider,
      modelId,
      runtimeType,
      ...(selection.provider !== provider || selection.runtimeType !== runtimeType
        ? { thinkingLevel: this.defaultThinkingLevel(settingKey) }
        : {}),
    });
    this.notify();

    if (!provider || !modelId || !runtimeType) {
      return { ok: true };
    }

    return this._persistModelSetting(settingKey);
  }

  async selectModelSettingThinkingLevel(settingKey: ModelSettingKey, thinkingLevel: string): Promise<SettingsStoreResult> {
    this._setSelectedModelSetting(settingKey, { thinkingLevel });
    this.notify();

    const selection = this.getSelectedModelSetting(settingKey);
    if (!selection.provider || !selection.modelId || !selection.runtimeType) {
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

      this._modelSettings[settingKey] = {
        stored: null,
        selected: { ...MODEL_SETTING_DEFAULTS[settingKey] },
      };
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.savingModel = false;
      this.notify();
    }
  }

  defaultThinkingLevel(settingKey: ModelSettingKey): string {
    return MODEL_SETTING_DEFAULTS[settingKey].thinkingLevel;
  }

  private async _persistModelSetting(settingKey: ModelSettingKey): Promise<SettingsStoreResult> {
    this.savingModel = true;
    this.notify();

    try {
      const body: ModelSetting = { ...this.getSelectedModelSetting(settingKey) };

      const res = await fetch(`/api/settings/${settingKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        return { error: await errorDetail(res) };
      }

      this._modelSettings[settingKey] = {
        ...this._modelSettings[settingKey],
        stored: body,
      };
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.savingModel = false;
      this.notify();
    }
  }

  private _applyLoadedModelSettings(entries: Array<{ key: ModelSettingKey; value: ModelSetting }>) {
    const loadedKeys = new Set(entries.map((entry) => entry.key));

    for (const settingKey of MODEL_SETTING_KEYS) {
      if (!loadedKeys.has(settingKey)) {
        this._modelSettings[settingKey] = {
          ...this._modelSettings[settingKey],
          stored: null,
        };
      }
    }

    for (const entry of entries) {
      this._modelSettings[entry.key] = {
        ...this._modelSettings[entry.key],
        stored: entry.value,
      };
    }
  }

  private _syncSelectionsFromSettings(settingKeys: ModelSettingKey[]) {
    for (const settingKey of settingKeys) {
      const model = this.getStoredModelSetting(settingKey);
      this._modelSettings[settingKey] = {
        stored: model,
        selected: model
          ? { ...model }
          : { ...MODEL_SETTING_DEFAULTS[settingKey] },
      };
    }
  }

  private _setSelectedModelSetting(settingKey: ModelSettingKey, updates: Partial<ModelSelection>) {
    this._modelSettings[settingKey] = {
      ...this._modelSettings[settingKey],
      selected: {
        ...this._modelSettings[settingKey].selected,
        ...updates,
      },
    };
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
