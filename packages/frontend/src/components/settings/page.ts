/**
 * Settings Page
 *
 * Routed full-screen page for global settings, organized into sections.
 * Desktop shows a section nav beside the current section; mobile shows the
 * section list and drills into one. Server-backed state and mutations live in
 * SettingsStore; this page owns section composition, loading and toast copy.
 * After its own sections, it has one page for each extension with settings
 * (`SettingsPages`), whose frame it draws around what the extension mounts.
 */

import type { ModelSettingsKey } from "@backend/settings-store.js";
import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { StoreController } from "../../controllers/store-controller.js";
import { ViewportController } from "../../controllers/viewport-controller.js";
import { SettingsStore, type SettingsChange } from "../../models/stores/settings-store.js";
import { closeSettings, showSettingsExtension, showSettingsSection, type SettingsSectionId } from "../../routing/app-router.js";
import type { ExtensionSettingsPage, SettingsPages } from "../../sdk-host/settings-pages.js";
import type { Mountable } from "../view-mount.js";
import { chevronLeftIcon, chevronRightIcon } from "../../ui/icons.js";
import { showToast } from "../../ui/toast.js";
import "./api-keys-section.js";
import "./model-setting-section.js";
import "./nodes-section.js";
import "./extensions-section.js";
import "./sidebar-section.js";
import "./extension-details.js";
import "../view-mount.js";

interface SectionDefinition {
  id: SettingsSectionId;
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
  description: "The machines that run sessions: pair new ones, check their connection, remove ones you no longer use.",
  load: async (store) => {
    const result = await store.nodesStore.load();
    if ("error" in result) showToast(`Failed to load nodes: ${result.error}`, "error");
  },
  render: (store) => html`<settings-nodes-section .store=${store.nodesStore}></settings-nodes-section>`,
};

/** The sidebar's sections: their order, and which are on. */
const SIDEBAR_SECTION: SectionDefinition = {
  id: "sidebar",
  label: "Sidebar",
  description: "The sections of the sidebar: their order, and which are shown.",
  load: async (store) => {
    try {
      await store.sidebarSections.load();
    } catch (error) {
      showToast(`Failed to load the sidebar's sections: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  },
  render: (store) => html`<settings-sidebar-section .sections=${store.sidebarSections}></settings-sidebar-section>`,
};

/** Reins' own list of every extension, apart from the pages extensions draw themselves. */
const EXTENSIONS_SECTION: SectionDefinition = {
  id: "extensions",
  label: "Extensions",
  description: "Every extension: whether it loaded, what it registered and what it stores.",
  load: async (store) => {
    const result = await store.extensionsStore.load();
    if ("error" in result) showToast(`Failed to load extensions: ${result.error}`, "error");
  },
  render: (store) => html`<settings-extensions-section .store=${store.extensionsStore}></settings-extensions-section>`,
};

const SECTIONS: readonly SectionDefinition[] = [MODELS_SECTION, NODES_SECTION, SIDEBAR_SECTION, EXTENSIONS_SECTION];

/** What the route shows: one of the page's own sections, Reins' page about an extension (part of the Extensions
 * section), or an extension's own page (null while it has none). */
type Shown =
  | { kind: "own"; definition: SectionDefinition }
  | { kind: "details"; name: string }
  | { kind: "extension"; name: string; page: ExtensionSettingsPage | null };

/** A row of the section nav and of the mobile section list. */
interface Row {
  key: string;
  label: string;
  description: string;
  icon?: Mountable;
  current: boolean;
  open: () => void;
}

function settingChangeToastMessage(change: SettingsChange): string {
  return `${change.key} was updated`;
}

@customElement("settings-page")
export class SettingsPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** The routed section; none is the bare settings URL or an extension's page. */
  @property({ attribute: false }) section: SettingsSectionId | null = null;

  /** The routed extension's page, by the extension's name. */
  @property({ attribute: false }) extension: string | null = null;

  /** The routed extension whose details page (Reins', under Extensions) is shown. */
  @property({ attribute: false }) extensionDetails: string | null = null;

  @property({ attribute: false }) store: SettingsStore | null = null;

  @property({ attribute: false })
  set extensionPages(pages: SettingsPages | null) {
    this._pagesCtrl.store = pages;
  }

  get extensionPages(): SettingsPages | null {
    return this._pagesCtrl.store;
  }

  private _storeCtrl = new StoreController<SettingsStore>(this);
  private _pagesCtrl = new StoreController<SettingsPages>(this);
  private _viewport = new ViewportController(this);
  private _unsubscribeSettingChanges: (() => void) | null = null;
  /** The section whose data was loaded for what is shown: a details page loads the Extensions section's. */
  private _loadedSection: SettingsSectionId | null = null;

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

  /** Each of the page's own sections loads its data when it is shown; an extension's page loads its own. */
  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("store")) this._syncStore();

    const definition = this._loadingSection(this._shown());
    if (!definition || !this.store || definition.id === this._loadedSection) return;
    this._loadedSection = definition.id;
    void definition.load(this.store);
  }

  private _loadingSection(shown: Shown | null): SectionDefinition | null {
    if (shown?.kind === "own") return shown.definition;
    return shown?.kind === "details" ? EXTENSIONS_SECTION : null;
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
  private _shown(): Shown | null {
    if (this.extension !== null) return { kind: "extension", name: this.extension, page: this.extensionPages?.page(this.extension) ?? null };
    if (this.extensionDetails !== null) return { kind: "details", name: this.extensionDetails };
    const id = this.section ?? (this._viewport.isMobileLayout ? null : SECTIONS[0]?.id);
    const definition = SECTIONS.find((section) => section.id === id);
    return definition ? { kind: "own", definition } : null;
  }

  private _shownLabel(shown: Shown): string {
    if (shown.kind === "own") return shown.definition.label;
    if (shown.kind === "details") return EXTENSIONS_SECTION.label;
    return shown.page?.extension.label ?? shown.name;
  }

  /** The page's own sections, then one row for each extension with settings. */
  private _rows(shown: Shown | null): Row[] {
    const own = SECTIONS.map((section): Row => ({
      key: section.id,
      label: section.label,
      description: section.description,
      current: (shown?.kind === "own" && shown.definition === section) || (shown?.kind === "details" && section === EXTENSIONS_SECTION),
      open: () => showSettingsSection(section.id),
    }));
    const extensions = (this.extensionPages?.pages() ?? []).map(({ extension }): Row => ({
      key: `extension:${extension.name}`,
      label: extension.label,
      description: extension.description ?? "",
      icon: extension.icon,
      current: shown?.kind === "extension" && shown.name === extension.name,
      open: () => showSettingsExtension(extension.name),
    }));
    return [...own, ...extensions];
  }

  private _renderHeader(shown: Shown | null) {
    const mobileInSection = this._viewport.isMobileLayout && shown !== null;

    return html`
      <header class="sticky top-0 z-[var(--layer-content)] flex h-[50px] items-center gap-1.5 border-b border-zinc-800/80 bg-zinc-900/95 px-2 backdrop-blur">
        <button
          class="shrink-0 cursor-pointer rounded-md p-2 text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-200"
          aria-label=${!mobileInSection ? "Close settings" : shown?.kind === "details" ? "Extensions" : "All settings"}
          @click=${() => !mobileInSection ? closeSettings() : showSettingsSection(shown?.kind === "details" ? "extensions" : null)}
        >${chevronLeftIcon()}</button>
        <div class="flex min-w-0 items-center gap-1.5 text-sm">
          ${mobileInSection
            ? html`
              <span class="truncate text-zinc-500">Settings</span>
              <span class="text-zinc-700" aria-hidden="true">/</span>
              <h1 class="shrink-0 font-semibold text-zinc-200">${this._shownLabel(shown)}</h1>
            `
            : html`<h1 class="shrink-0 font-semibold text-zinc-200">Settings</h1>`}
        </div>
        ${this._viewport.isStandalone
          ? html`<button
              class="ml-auto shrink-0 cursor-pointer rounded-md px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-200"
              title="Reload the app"
              @click=${() => location.reload()}
            >Reload</button>`
          : nothing}
      </header>
    `;
  }

  private _renderNav(rows: readonly Row[]) {
    return html`
      <nav class="w-44 shrink-0" aria-label="Settings sections">
        <ul class="space-y-0.5">
          ${repeat(rows, (row) => row.key, (row) => html`
            <li>
              <button
                type="button"
                class="w-full cursor-pointer rounded-md px-3 py-1.5 text-left text-sm transition-colors ${row.current
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}"
                aria-current=${row.current ? "page" : "false"}
                @click=${row.open}
              ><span class="flex items-center gap-2">${this._renderIcon(row)}<span class="min-w-0 truncate">${row.label}</span></span></button>
            </li>
          `)}
        </ul>
      </nav>
    `;
  }

  private _renderSectionList(rows: readonly Row[]) {
    return html`
      <nav class="px-3 py-4" aria-label="Settings sections">
        <ul class="divide-y divide-zinc-800 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/25">
          ${repeat(rows, (row) => row.key, (row) => html`
            <li>
              <button
                type="button"
                class="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/60"
                @click=${row.open}
              >
                ${this._renderIcon(row)}
                <span class="min-w-0 flex-1">
                  <span class="block text-sm font-medium text-zinc-200">${row.label}</span>
                  ${row.description ? html`<span class="mt-0.5 block text-xs text-zinc-500">${row.description}</span>` : nothing}
                </span>
                <span class="shrink-0 text-zinc-600">${chevronRightIcon("", 15)}</span>
              </button>
            </li>
          `)}
        </ul>
      </nav>
    `;
  }

  /** An extension's icon, drawn by the extension; clipped, so a failure's message stays in its box. */
  private _renderIcon(row: Row) {
    return row.icon
      ? html`<reins-view-mount class="block size-3.5 shrink-0 overflow-hidden" aria-hidden="true" .presentation=${row.icon}></reins-view-mount>`
      : nothing;
  }

  private _renderPageHeader(label: string, description: string | undefined) {
    return html`
      <div class="mb-6 hidden md:block">
        <h2 class="text-base font-semibold text-zinc-100">${label}</h2>
        ${description ? html`<p class="mt-1 text-xs text-zinc-500">${description}</p>` : nothing}
      </div>
    `;
  }

  private _renderShown(shown: Shown, store: SettingsStore) {
    if (shown.kind === "own") {
      return html`
        <div class="min-w-0 max-w-2xl flex-1">
          ${this._renderPageHeader(shown.definition.label, shown.definition.description)}
          ${shown.definition.render(store)}
        </div>
      `;
    }
    if (shown.kind === "details") {
      return html`
        <div class="min-w-0 max-w-2xl flex-1">
          <settings-extension-details .store=${store.extensionsStore} .name=${shown.name}></settings-extension-details>
        </div>
      `;
    }
    const { page } = shown;
    if (!page) {
      return html`
        <div class="min-w-0 max-w-2xl flex-1">
          <p class="py-4 text-sm text-zinc-400">No settings for “${shown.name}”.</p>
          <p class="text-xs text-zinc-500">No extension of that name has settings.</p>
        </div>
      `;
    }
    return html`
      <div class="min-w-0 max-w-2xl flex-1">
        ${this._renderPageHeader(page.extension.label, page.extension.description)}
        <reins-view-mount class="block" .presentation=${page.settings}></reins-view-mount>
      </div>
    `;
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;

    const shown = this._shown();
    const rows = this._rows(shown);

    return html`
      <main class="h-full overflow-y-auto bg-zinc-900 text-zinc-100" data-settings-page>
        ${this._renderHeader(shown)}
        ${shown
          ? html`
            <div class="mx-auto flex max-w-5xl gap-10 px-4 py-6 md:px-8 md:py-8">
              ${this._viewport.isMobileLayout ? nothing : this._renderNav(rows)}
              ${this._renderShown(shown, store)}
            </div>
          `
          : this._renderSectionList(rows)}
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-page": SettingsPage;
  }
}
