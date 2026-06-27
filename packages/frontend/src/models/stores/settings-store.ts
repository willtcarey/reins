/**
 * Settings Store
 *
 * Owns server-backed state for settings values, OAuth provider metadata,
 * and settings-related mutations, including model/provider registry loading.
 */

import { ModelRegistryStore } from "./model-registry-store.js";

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
export type DiffRenderer = "classic" | "virtual";
export type SettingsKey = ModelSettingKey | "diff_renderer";
export type SettingsChange = { key: string };
export type SettingsChangeListener = (change: SettingsChange) => void;

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

type LoadedSettingEntry =
  | { key: ModelSettingKey; value: ModelSetting }
  | { key: "diff_renderer"; value: DiffRenderer };

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
  savingDiffRenderer = false;

  oauthProviders: OAuthProviderInfo[] = [];

  oauthLoginProvider = "";
  oauthAuthUrl = "";
  oauthInstructions = "";

  diffRenderer: DiffRenderer = "classic";
  readonly registryStore = new ModelRegistryStore();

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
  private _settingChangeListeners = new Set<SettingsChangeListener>();

  constructor() {
    this.registryStore.subscribe(() => this.notify());
  }

  subscribe(fn: SettingsStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  subscribeSettingChanges(fn: SettingsChangeListener): () => void {
    this._settingChangeListeners.add(fn);
    return () => this._settingChangeListeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  private notifySettingChanged(change: SettingsChange) {
    for (const fn of this._settingChangeListeners) fn(change);
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

  async loadSettings(settingKeys: readonly SettingsKey[] = ["default_model", "utility_model", "diff_renderer"]): Promise<SettingsStoreResult> {
    this.loading = true;
    this.notify();

    try {
      const settingsQuery = settingKeys.map((key) => `key=${encodeURIComponent(key)}`).join("&");
      const [settingsRes, oauthRes] = await Promise.all([
        settingKeys.length > 0 ? fetch(`/api/settings?${settingsQuery}`) : emptyJsonResponse(),
        fetch("/api/oauth/providers"),
      ]);

      if (!settingsRes.ok) {
        return { error: await errorDetail(settingsRes) };
      }
      this._applyLoadedSettings(await settingsRes.json(), settingKeys);

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

  async loadModelRegistry(): Promise<SettingsStoreResult> {
    return await this.registryStore.load();
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

      this.notifySettingChanged({ key: `api_key_${provider}` });
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

      this.notifySettingChanged({ key: `api_key_${provider}` });
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
      const providerId = this.oauthLoginProvider;
      const res = await fetch(`/api/oauth/callback/${providerId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      if (!res.ok) {
        return { error: await errorDetail(res) };
      }

      const result = await this.loadSettings();
      if ("error" in result) return result;

      this.notifySettingChanged({ key: `oauth_${providerId}` });
      return result;
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

      const result = await this.loadSettings();
      if ("error" in result) return result;

      this.notifySettingChanged({ key: `oauth_${providerId}` });
      return result;
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

  async selectDiffRenderer(renderer: DiffRenderer): Promise<SettingsStoreResult> {
    this.savingDiffRenderer = true;
    this.notify();

    try {
      const res = await fetch("/api/settings/diff_renderer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(renderer),
      });

      if (!res.ok) {
        return { error: await errorDetail(res) };
      }

      this.diffRenderer = renderer;
      this.notifySettingChanged({ key: "diff_renderer" });
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.savingDiffRenderer = false;
      this.notify();
    }
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
      this.notifySettingChanged({ key: settingKey });
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
      this.notifySettingChanged({ key: settingKey });
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.savingModel = false;
      this.notify();
    }
  }

  private _applyLoadedSettings(entries: LoadedSettingEntry[], settingKeys: readonly SettingsKey[]) {
    const loadedKeys = new Set(entries.map((entry) => entry.key));

    for (const settingKey of MODEL_SETTING_KEYS) {
      if (settingKeys.includes(settingKey) && !loadedKeys.has(settingKey)) {
        this._modelSettings[settingKey] = {
          ...this._modelSettings[settingKey],
          stored: null,
        };
      }
    }

    if (settingKeys.includes("diff_renderer") && !loadedKeys.has("diff_renderer")) {
      this.diffRenderer = "classic";
    }

    for (const entry of entries) {
      if (entry.key === "diff_renderer") {
        this.diffRenderer = entry.value === "virtual" ? "virtual" : "classic";
        continue;
      }

      this._modelSettings[entry.key] = {
        ...this._modelSettings[entry.key],
        stored: entry.value,
      };
    }
  }

  private _syncSelectionsFromSettings(settingKeys: readonly SettingsKey[]) {
    for (const settingKey of settingKeys) {
      if (settingKey === "diff_renderer") continue;
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

function emptyJsonResponse(): Response {
  return new Response("[]", {
    headers: { "Content-Type": "application/json" },
  });
}

async function errorDetail(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return body?.error ?? `HTTP ${response.status}`;
}
