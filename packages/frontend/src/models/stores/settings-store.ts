/**
 * Settings Store
 *
 * Owns server-backed state for settings values, OAuth provider metadata,
 * and settings-related mutations, including model/provider registry loading.
 * The settings panel's nodes live in its NodesStore.
 */

import type { OAuthProviderInfo } from "@backend/routes/oauth.js";
import type { ModelSetting, ModelSettingsKey as ModelSettingKey, SettingEntry } from "@backend/settings-store.js";
import { api } from "../api.js";
import { ModelRegistryStore } from "./model-registry-store.js";
import { NodesStore } from "./nodes-store.js";

export type SettingsStoreResult = { ok: true } | { error: string };
export type SettingsStoreListener = () => void;
type SettingsKey = ModelSettingKey;
export type SettingsChange = { key: string };
export type SettingsChangeListener = (change: SettingsChange) => void;

type ModelSelection = ModelSetting;

type ModelSettingState = {
  stored: ModelSetting | null;
  selected: ModelSelection;
};

type LoadedSettingEntry = SettingEntry<ModelSettingKey>;

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
  oauthLoading = false;

  oauthProviders: OAuthProviderInfo[] = [];

  oauthLoginProvider = "";
  oauthAuthUrl = "";
  oauthInstructions = "";

  readonly registryStore = new ModelRegistryStore();
  readonly nodesStore = new NodesStore();

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

  async loadSettings(settingKeys: readonly SettingsKey[]): Promise<SettingsStoreResult> {
    this.loading = true;
    this.notify();

    try {
      const [settings, oauthProviders] = await Promise.all([
        settingKeys.length > 0
          ? api.settings.list(settingKeys)
          : Promise.resolve([]),
        api.oauth.providers(),
      ]);

      this._applyLoadedSettings(settings, settingKeys);
      this.oauthProviders = oauthProviders;

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
    try {
      await api.auth.putApiKey(provider, value);
      this.notifySettingChanged({ key: `api_key_${provider}` });
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    }
  }

  async deleteApiKey(provider: string): Promise<SettingsStoreResult> {
    try {
      await api.auth.deleteApiKey(provider);
      this.notifySettingChanged({ key: `api_key_${provider}` });
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    }
  }

  async startOAuthLogin(providerId: string): Promise<SettingsStoreResult> {
    this.oauthLoading = true;
    this.oauthLoginProvider = providerId;
    this.oauthAuthUrl = "";
    this.oauthInstructions = "";
    this.notify();

    try {
      const data = await api.oauth.start(providerId);
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
      await api.oauth.callback(providerId, code);
      const result = await this.loadSettings([]);
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
      await api.oauth.disconnect(providerId);
      const result = await this.loadSettings([]);
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

  async selectModelSettingThinkingLevel(
    settingKey: ModelSettingKey,
    thinkingLevel: ModelSetting["thinkingLevel"],
  ): Promise<SettingsStoreResult> {
    this._setSelectedModelSetting(settingKey, { thinkingLevel });
    this.notify();

    const selection = this.getSelectedModelSetting(settingKey);
    if (!selection.provider || !selection.modelId || !selection.runtimeType) {
      return { ok: true };
    }

    return this._persistModelSetting(settingKey);
  }

  async clearModelSetting(settingKey: ModelSettingKey): Promise<SettingsStoreResult> {
    try {
      await api.settings.delete(settingKey);
      this._modelSettings[settingKey] = {
        stored: null,
        selected: { ...MODEL_SETTING_DEFAULTS[settingKey] },
      };
      this.notifySettingChanged({ key: settingKey });
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    }
  }

  defaultThinkingLevel(settingKey: ModelSettingKey): ModelSetting["thinkingLevel"] {
    return MODEL_SETTING_DEFAULTS[settingKey].thinkingLevel;
  }

  private async _persistModelSetting(settingKey: ModelSettingKey): Promise<SettingsStoreResult> {
    try {
      const body: ModelSetting = { ...this.getSelectedModelSetting(settingKey) };

      await api.settings.put(settingKey, body);
      this._modelSettings[settingKey] = {
        ...this._modelSettings[settingKey],
        stored: body,
      };
      this.notifySettingChanged({ key: settingKey });
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
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

    for (const entry of entries) {
      this._modelSettings[entry.key] = {
        ...this._modelSettings[entry.key],
        stored: entry.value,
      };
    }
  }

  private _syncSelectionsFromSettings(settingKeys: readonly SettingsKey[]) {
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
