/**
 * Settings Panel
 *
 * Full-screen overlay for managing global settings.
 * Server-backed state and mutations live in SettingsStore.
 * This shell owns overlay visibility and visible setting composition.
 */

import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { SettingsStore, type SettingsChange, type SettingsKey } from "../../models/stores/settings-store.js";
import { showToast } from "../toast.js";
import "./api-keys-section.js";
import "./diff-renderer-section.js";
import "./model-setting-section.js";

interface SettingRenderContext {
  settingsStore: SettingsStore;
}

interface SettingDefinition {
  id: string;
  settingKeys?: readonly SettingsKey[];
  render: (context: SettingRenderContext) => TemplateResult;
}

const API_KEYS_SETTING: SettingDefinition = {
  id: "api-keys",
  render: ({ settingsStore }) => html`
    <settings-api-keys-section .store=${settingsStore}></settings-api-keys-section>
  `,
};

const DEFAULT_MODEL_SETTING: SettingDefinition = {
  id: "default-model",
  settingKeys: ["default_model"],
  render: ({ settingsStore }) => html`
    <h3 class="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Default Model</h3>
    <p class="text-[10px] text-zinc-500 mb-3">New sessions will use this model. Existing sessions are not affected.</p>
    <settings-model-setting-section
      .store=${settingsStore}
      settingKey="default_model"
      emptyMessage="Configure at least one API key above to select a default model."
      currentLabel="Current"
    ></settings-model-setting-section>
  `,
};

const DIFF_RENDERER_SETTING: SettingDefinition = {
  id: "diff-renderer",
  settingKeys: ["diff_renderer"],
  render: ({ settingsStore }) => html`
    <settings-diff-renderer-section .store=${settingsStore}></settings-diff-renderer-section>
  `,
};

const UTILITY_MODEL_SETTING: SettingDefinition = {
  id: "utility-model",
  settingKeys: ["utility_model"],
  render: ({ settingsStore }) => html`
    <h3 class="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Utility Model</h3>
    <p class="text-[10px] text-zinc-500 mb-3">Used for lightweight internal tasks like task generation and branch naming. Falls back to the default model when unset.</p>
    <settings-model-setting-section
      .store=${settingsStore}
      settingKey="utility_model"
      emptyMessage="Configure at least one API key above to select a utility model."
      currentLabel="Utility model"
    ></settings-model-setting-section>
  `,
};

function visibleSettings(): readonly SettingDefinition[] {
  return [
    API_KEYS_SETTING,
    DEFAULT_MODEL_SETTING,
    ...(typeof REINS_DEV !== "undefined" && REINS_DEV ? [DIFF_RENDERER_SETTING] : []),
    UTILITY_MODEL_SETTING,
  ];
}

function settingKeysForSettings(settings: readonly SettingDefinition[]): SettingsKey[] {
  const keys = new Set<SettingsKey>();
  for (const setting of settings) {
    for (const key of setting.settingKeys ?? []) keys.add(key);
  }
  return [...keys];
}

function settingChangeToastMessage(change: SettingsChange): string {
  return `${change.key} was updated`;
}

@customElement("settings-panel")
export class SettingsPanel extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private _open = false;

  @property({ attribute: false }) store!: SettingsStore;

  private _storeCtrl = new StoreController<SettingsStore>(this);
  private _unsubscribeSettingChanges: (() => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this._syncStoreSubscriptions();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("store")) {
      this._syncStoreSubscriptions();
    }
  }

  override disconnectedCallback() {
    this._unsubscribeSettingChanges?.();
    this._unsubscribeSettingChanges = null;
    super.disconnectedCallback();
  }

  private _syncStoreSubscriptions() {
    this._unsubscribeSettingChanges?.();
    this._unsubscribeSettingChanges = null;
    this._storeCtrl.store = this.store;
    this._unsubscribeSettingChanges = this.store.subscribeSettingChanges((change) => this._handleSettingChanged(change));
  }

  private _handleSettingChanged(change: SettingsChange) {
    showToast(settingChangeToastMessage(change), "success");
  }

  open() {
    this._open = true;
    void this._loadData();
  }

  close() {
    this._open = false;
  }

  private _loadData() {
    void this._loadVisibleSettings();
    void this.store.loadModelRegistry();
  }

  private async _loadVisibleSettings() {
    const result = await this.store.loadSettings(settingKeysForSettings(visibleSettings()));

    if ("error" in result) {
      showToast(`Failed to load settings: ${result.error}`, "error");
    }
  }

  private _handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      this.close();
    }
  }

  override render() {
    if (!this._open) return nothing;

    const settings = visibleSettings();
    const store = this.store;

    return html`
      <div
        class="fixed inset-0 z-[var(--layer-overlay)] bg-black/50 backdrop-blur-sm flex items-start justify-center pt-[10vh] overflow-y-auto"
        @click=${this._handleBackdropClick}
      >
        <div class="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl w-[calc(100vw-2rem)] max-w-lg p-5 mb-8">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-sm font-medium text-zinc-200">Settings</h2>
            <button
              class="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
              @click=${() => this.close()}
              title="Close settings"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
              </svg>
            </button>
          </div>

          ${store.loading
            ? html`<div class="text-xs text-zinc-500 py-4 text-center">Loading settings...</div>`
            : settings.map((setting, index) => html`
              <div class=${index < settings.length - 1 ? "mb-5" : ""}>
                ${setting.render({ settingsStore: store })}
              </div>
            `)}
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
