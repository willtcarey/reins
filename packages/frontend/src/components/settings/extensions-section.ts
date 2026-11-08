import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { StoreController } from "../../controllers/store-controller.js";
import type { ExtensionSummary, ExtensionsStore } from "../../models/stores/extensions-store.js";
import { showSettingsExtensionDetails } from "../../routing/app-router.js";
import { statusDot } from "../../ui/status-dot.js";
import { statusTone } from "./extension-status.js";
import "../view-mount.js";

/** Settings' Extensions section: a card for each extension, which opens Reins' page about it. Every card has
 * the same rows, its description cut to two lines, so all are one size; the details page has the rest. */
@customElement("settings-extensions-section")
export class SettingsExtensionsSection extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _storeCtrl = new StoreController<ExtensionsStore>(this);

  @property({ attribute: false })
  set store(store: ExtensionsStore | null) {
    this._storeCtrl.store = store;
  }

  get store(): ExtensionsStore | null {
    return this._storeCtrl.store;
  }

  private _renderCard(extension: ExtensionSummary) {
    const failed = extension.status === "failed";
    return html`
      <button
        type="button"
        class="flex h-full w-full cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${failed
          ? "border-red-500/40 bg-red-950/10 hover:bg-red-950/20"
          : "border-zinc-700 bg-zinc-800/40 hover:bg-zinc-800/80"}"
        @click=${() => showSettingsExtensionDetails(extension.name)}
      >
        <span class="flex min-w-0 items-center gap-2">
          ${extension.icon
            ? html`<reins-view-mount class="block size-3.5 shrink-0 overflow-hidden" aria-hidden="true" .presentation=${extension.icon}></reins-view-mount>`
            : nothing}
          <span class="truncate text-sm font-medium text-zinc-200">${extension.label}</span>
          <span class="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-zinc-400">${statusDot(statusTone(extension))}${extension.status}</span>
        </span>
        <span class="line-clamp-2 min-h-[2lh] text-[11px] text-zinc-500" title=${extension.description ?? nothing}>${extension.description ?? ""}</span>
        ${extension.source.kind === "path"
          ? html`<span class="truncate font-mono text-[10px] text-zinc-500" title=${extension.source.path}>${extension.source.path}</span>`
          : html`<span class="text-[10px] text-zinc-500">Built in</span>`}
      </button>
    `;
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;
    return html`
      ${store.backendError
        ? html`<p class="mb-3 text-xs text-amber-400/90" role="status">Could not load the server's extensions: ${store.backendError}</p>`
        : nothing}
      ${store.backend.loading && !store.backend.data
        ? html`<div class="py-2 text-xs text-zinc-500">Loading extensions...</div>`
        : nothing}
      <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        ${repeat(store.extensions, (extension) => extension.name, (extension) => html`<li>${this._renderCard(extension)}</li>`)}
      </ul>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-extensions-section": SettingsExtensionsSection;
  }
}
