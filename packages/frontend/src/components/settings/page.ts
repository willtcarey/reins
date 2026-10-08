/**
 * Settings Page
 *
 * Routed full-screen page for global settings, organized into sections.
 * Desktop shows a section nav beside the current section; mobile shows the
 * section list and drills into one. Server-backed state and mutations live in
 * SettingsStore; this page owns section composition, loading and toast copy.
 */

import type { ModelSettingsKey } from "@backend/settings-store.js";
import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { ViewportController } from "../../controllers/viewport-controller.js";
import { SettingsStore, type SettingsChange } from "../../models/stores/settings-store.js";
import { closeSettings, showSettingsSection, type SettingsSection } from "../../routing/app-router.js";
import { chevronLeftIcon, chevronRightIcon } from "../../ui/icons.js";
import { showToast } from "../toast.js";
import "./api-keys-section.js";
import "./model-setting-section.js";
import "./nodes-section.js";

interface SectionDefinition {
  id: SettingsSection;
  label: string;
  description: string;
  load: (store: SettingsStore) => Promise<void>;
  render: (store: SettingsStore) => TemplateResult;
}

const MODEL_SETTING_KEYS: readonly ModelSettingsKey[] = ["default_model", "utility_model"];

function renderSubsection(title: string, description: string | null, body: TemplateResult) {
  return html`
    <section>
      <h2 class="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">${title}</h2>
      ${description ? html`<p class="text-[11px] text-zinc-500 mb-3">${description}</p>` : nothing}
      ${body}
    </section>
  `;
}

const MODELS_SECTION: SectionDefinition = {
  id: "models",
  label: "Models",
  description: "The models new sessions and background work use, and the providers that supply them.",
  load: async (store) => {
    const [settings, registry] = await Promise.all([
      store.loadSettings(MODEL_SETTING_KEYS),
      store.loadModelRegistry(),
    ]);
    if ("error" in settings) showToast(`Failed to load settings: ${settings.error}`, "error");
    if ("error" in registry) showToast(`Failed to load models: ${registry.error}`, "error");
  },
  render: (store) => store.loading
    ? html`<div class="text-xs text-zinc-500 py-4">Loading settings...</div>`
    : html`
      <div class="space-y-8">
        ${renderSubsection("Default model", "New sessions use this model. Existing sessions are not affected.", html`
          <settings-model-setting-section
            .store=${store}
            settingKey="default_model"
            emptyMessage="Add a provider under Providers to choose a default model."
            currentLabel="Current"
          ></settings-model-setting-section>
        `)}
        ${renderSubsection("Utility model", "Used for lightweight internal tasks like task generation and branch naming. Falls back to the default model when unset.", html`
          <settings-model-setting-section
            .store=${store}
            settingKey="utility_model"
            emptyMessage="Add a provider under Providers to choose a utility model."
            currentLabel="Utility model"
          ></settings-model-setting-section>
        `)}
        <settings-api-keys-section .store=${store}></settings-api-keys-section>
      </div>
    `,
};

const NODES_SECTION: SectionDefinition = {
  id: "nodes",
  label: "Nodes",
  description: "The machines that run sessions: pair new ones, check their connection, revoke lost ones.",
  load: async (store) => {
    const result = await store.nodesStore.load();
    if ("error" in result) showToast(`Failed to load nodes: ${result.error}`, "error");
  },
  render: (store) => html`<settings-nodes-section .store=${store.nodesStore}></settings-nodes-section>`,
};

const SECTIONS: readonly SectionDefinition[] = [MODELS_SECTION, NODES_SECTION];

function settingChangeToastMessage(change: SettingsChange): string {
  return `${change.key} was updated`;
}

@customElement("settings-page")
export class SettingsPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** The routed section; none is the bare settings URL. */
  @property({ attribute: false }) section: SettingsSection | null = null;

  @property({ attribute: false }) store: SettingsStore | null = null;

  private _storeCtrl = new StoreController<SettingsStore>(this);
  private _viewport = new ViewportController(this);
  private _unsubscribeSettingChanges: (() => void) | null = null;
  private _loadedSection: SettingsSection | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this._syncStore();
  }

  override disconnectedCallback() {
    this._unsubscribeSettingChanges?.();
    this._unsubscribeSettingChanges = null;
    this._loadedSection = null;
    super.disconnectedCallback();
  }

  /** Each section loads its data when it is shown. */
  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("store")) this._syncStore();

    const shown = this._shownSection();
    if (!shown || !this.store || shown.id === this._loadedSection) return;
    this._loadedSection = shown.id;
    void shown.load(this.store);
  }

  private _syncStore() {
    this._storeCtrl.store = this.store;
    this._loadedSection = null;
    this._unsubscribeSettingChanges?.();
    this._unsubscribeSettingChanges = this.store?.subscribeSettingChanges((change) => {
      showToast(settingChangeToastMessage(change), "success");
    }) ?? null;
  }

  /** On desktop the bare URL shows the first section; on mobile it shows the section list. */
  private _shownSection(): SectionDefinition | null {
    const id = this.section ?? (this._viewport.isMobileLayout ? null : SECTIONS[0]?.id);
    return SECTIONS.find((section) => section.id === id) ?? null;
  }

  private _renderHeader(shown: SectionDefinition | null) {
    const mobileInSection = this._viewport.isMobileLayout && shown !== null;

    return html`
      <header class="sticky top-0 z-[var(--layer-content)] flex h-[50px] items-center gap-1.5 border-b border-zinc-800/80 bg-zinc-900/95 px-2 backdrop-blur">
        <button
          class="shrink-0 cursor-pointer rounded-md p-2 text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-200"
          aria-label=${mobileInSection ? "All settings" : "Close settings"}
          @click=${() => mobileInSection ? showSettingsSection(null) : closeSettings()}
        >${chevronLeftIcon()}</button>
        <div class="flex min-w-0 items-center gap-1.5 text-sm">
          ${mobileInSection
            ? html`
              <span class="truncate text-zinc-500">Settings</span>
              <span class="text-zinc-700" aria-hidden="true">/</span>
              <h1 class="shrink-0 font-semibold text-zinc-200">${shown.label}</h1>
            `
            : html`<h1 class="shrink-0 font-semibold text-zinc-200">Settings</h1>`}
        </div>
      </header>
    `;
  }

  private _renderNav(shown: SectionDefinition | null) {
    return html`
      <nav class="w-44 shrink-0" aria-label="Settings sections">
        <ul class="space-y-0.5">
          ${SECTIONS.map((section) => html`
            <li>
              <button
                type="button"
                class="w-full cursor-pointer rounded-md px-3 py-1.5 text-left text-sm transition-colors ${section === shown
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}"
                aria-current=${section === shown ? "page" : "false"}
                @click=${() => showSettingsSection(section.id)}
              >${section.label}</button>
            </li>
          `)}
        </ul>
      </nav>
    `;
  }

  private _renderSectionList() {
    return html`
      <nav class="px-3 py-4" aria-label="Settings sections">
        <ul class="divide-y divide-zinc-800 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/25">
          ${SECTIONS.map((section) => html`
            <li>
              <button
                type="button"
                class="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/60"
                @click=${() => showSettingsSection(section.id)}
              >
                <span class="min-w-0 flex-1">
                  <span class="block text-sm font-medium text-zinc-200">${section.label}</span>
                  <span class="mt-0.5 block text-xs text-zinc-500">${section.description}</span>
                </span>
                <span class="shrink-0 text-zinc-600">${chevronRightIcon("", 15)}</span>
              </button>
            </li>
          `)}
        </ul>
      </nav>
    `;
  }

  private _renderSection(section: SectionDefinition, store: SettingsStore) {
    return html`
      <div class="min-w-0 max-w-2xl flex-1">
        <div class="mb-6 hidden md:block">
          <h2 class="text-base font-semibold text-zinc-100">${section.label}</h2>
          <p class="mt-1 text-xs text-zinc-500">${section.description}</p>
        </div>
        ${section.render(store)}
      </div>
    `;
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;

    const shown = this._shownSection();

    return html`
      <main class="h-full overflow-y-auto bg-zinc-900 text-zinc-100" data-settings-page>
        ${this._renderHeader(shown)}
        ${shown
          ? html`
            <div class="mx-auto flex max-w-5xl gap-10 px-4 py-6 md:px-8 md:py-8">
              ${this._viewport.isMobileLayout ? nothing : this._renderNav(shown)}
              ${this._renderSection(shown, store)}
            </div>
          `
          : this._renderSectionList()}
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-page": SettingsPage;
  }
}
