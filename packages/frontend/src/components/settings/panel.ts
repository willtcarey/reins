/**
 * Settings Panel
 *
 * Full-screen overlay for managing global settings.
 * Server-backed state and mutations live in SettingsStore.
 * This shell owns overlay visibility and visible setting composition.
 */

import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { SettingsStore, type SettingsLoadDeclaration } from "../../models/stores/settings-store.js";
import { showToast } from "../toast.js";
import "./api-keys-section.js";
import "./diff-renderer-section.js";
import "./model-setting-section.js";

interface SettingsSectionContext {
  settingsStore: SettingsStore;
}

interface SettingsSectionDefinition extends SettingsLoadDeclaration {
  id: string;
  visible?: () => boolean;
  render: (context: SettingsSectionContext) => TemplateResult;
}

const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  {
    id: "api-keys",
    render: ({ settingsStore }) => html`
      <settings-api-keys-section .store=${settingsStore}></settings-api-keys-section>
    `,
  },
  {
    id: "default-model",
    settingKeys: ["default_model"],
    render: ({ settingsStore }) => html`
      <h3 class="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Default Model</h3>
      <p class="text-[10px] text-zinc-500 mb-3">New sessions will use this model. Existing sessions are not affected.</p>
      <settings-model-setting-section
        .store=${settingsStore}
        settingKey="default_model"
        emptyMessage="Configure at least one API key above to select a default model."
        successLabel="Default model updated"
        currentLabel="Current"
        clearSuccessLabel="Default model cleared"
      ></settings-model-setting-section>
    `,
  },
  {
    id: "diff-renderer",
    settingKeys: ["diff_renderer"],
    visible: () => typeof REINS_DEV !== "undefined" && REINS_DEV,
    render: ({ settingsStore }) => html`
      <settings-diff-renderer-section .store=${settingsStore}></settings-diff-renderer-section>
    `,
  },
  {
    id: "utility-model",
    settingKeys: ["utility_model"],
    render: ({ settingsStore }) => html`
      <h3 class="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Utility Model</h3>
      <p class="text-[10px] text-zinc-500 mb-3">Used for lightweight internal tasks like task generation and branch naming. Falls back to the default model when unset.</p>
      <settings-model-setting-section
        .store=${settingsStore}
        settingKey="utility_model"
        emptyMessage="Configure at least one API key above to select a utility model."
        successLabel="Utility model updated"
        currentLabel="Utility model"
        clearSuccessLabel="Utility model cleared"
      ></settings-model-setting-section>
    `,
  },
];

@customElement("settings-panel")
export class SettingsPanel extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private _open = false;

  private _store = new SettingsStore();
  private _storeCtrl = new StoreController<SettingsStore>(this);

  constructor() {
    super();
    this._storeCtrl.store = this._store;
  }

  private get store(): SettingsStore {
    return this._store;
  }

  open() {
    this._open = true;
    void this._loadData();
  }

  close() {
    this._open = false;
  }

  private _loadData() {
    void this._loadSettingsSections();
  }

  private async _loadSettingsSections() {
    const result = await this.store.loadSettingsSections(this._visibleSections);

    if ("error" in result) {
      showToast(`Failed to load settings: ${result.error}`, "error");
    }
  }

  private get _visibleSections(): readonly SettingsSectionDefinition[] {
    return SETTINGS_SECTIONS.filter((section) => section.visible?.() ?? true);
  }

  private _handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      this.close();
    }
  }

  override render() {
    if (!this._open) return nothing;

    const sections = this._visibleSections;

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

          ${this.store.loading
            ? html`<div class="text-xs text-zinc-500 py-4 text-center">Loading settings...</div>`
            : sections.map((section, index) => html`
              <div class=${index < sections.length - 1 ? "mb-5" : ""}>
                ${section.render({ settingsStore: this.store })}
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
