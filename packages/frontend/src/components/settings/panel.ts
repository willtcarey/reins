/**
 * Settings Panel
 *
 * Full-screen overlay for managing global settings.
 * Server-backed state and mutations live in SettingsStore and ModelCatalogStore.
 * This shell owns only overlay visibility, data loading, and section composition.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { ModelCatalogStore } from "../../models/stores/model-catalog-store.js";
import { SettingsStore } from "../../models/stores/settings-store.js";
import { showToast } from "../toast.js";
import "./api-keys-section.js";
import "./model-setting-section.js";

@customElement("settings-panel")
export class SettingsPanel extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private _open = false;

  private _store = new SettingsStore();
  private _catalogStore = new ModelCatalogStore();
  private _storeCtrl = new StoreController<SettingsStore>(this);
  private _catalogStoreCtrl = new StoreController<ModelCatalogStore>(this);

  constructor() {
    super();
    this._storeCtrl.store = this._store;
    this._catalogStoreCtrl.store = this._catalogStore;
  }

  private get store(): SettingsStore {
    return this._store;
  }

  private get catalogStore(): ModelCatalogStore {
    return this._catalogStore;
  }

  open() {
    this._open = true;
    void this._loadData();
  }

  close() {
    this._open = false;
  }

  private async _loadData() {
    const [settingsResult, catalogResult] = await Promise.all([
      this.store.load(),
      this.catalogStore.load(),
    ]);

    if ("error" in settingsResult) {
      showToast(`Failed to load settings: ${settingsResult.error}`, "error");
    }
    if ("error" in catalogResult) {
      showToast(`Failed to load model catalog: ${catalogResult.error}`, "error");
    }
  }

  private _handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      this.close();
    }
  }

  override render() {
    if (!this._open) return nothing;

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

          ${this.store.loading || this.catalogStore.loading
            ? html`<div class="text-xs text-zinc-500 py-4 text-center">Loading settings...</div>`
            : html`
              <div class="mb-5">
                <settings-api-keys-section .store=${this.store} .catalogStore=${this.catalogStore}></settings-api-keys-section>
              </div>

              <div class="mb-5">
                <h3 class="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Default Model</h3>
                <p class="text-[10px] text-zinc-500 mb-3">New sessions will use this model. Existing sessions are not affected.</p>
                <settings-model-setting-section
                  .store=${this.store}
                  .catalogStore=${this.catalogStore}
                  settingKey="default_model"
                  emptyMessage="Configure at least one API key above to select a default model."
                  successLabel="Default model updated"
                  currentLabel="Current"
                  clearSuccessLabel="Default model cleared"
                ></settings-model-setting-section>
              </div>

              <div>
                <h3 class="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Utility Model</h3>
                <p class="text-[10px] text-zinc-500 mb-3">Used for lightweight internal tasks like task generation and branch naming. Falls back to the default model when unset.</p>
                <settings-model-setting-section
                  .store=${this.store}
                  .catalogStore=${this.catalogStore}
                  settingKey="utility_model"
                  emptyMessage="Configure at least one API key above to select a utility model."
                  successLabel="Utility model updated"
                  currentLabel="Utility model"
                  clearSuccessLabel="Utility model cleared"
                ></settings-model-setting-section>
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
