import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { formatBytes } from "../../helpers/format-bytes.js";
import type { ExtensionSummary, ExtensionsStore } from "../../models/stores/extensions-store.js";
import { showSettingsExtension, showSettingsSection } from "../../routing/app-router.js";
import { chevronLeftIcon } from "../../ui/icons.js";
import { statusDot } from "../../ui/status-dot.js";
import "../view-mount.js";
import { serviceState } from "./service-status.js";

/** A labelled row; nothing for an empty value, so only what an extension has is shown. */
function row(label: string, value: TemplateResult | string | null) {
  if (value === null) return nothing;
  return html`
    <div class="grid grid-cols-[9rem_1fr] gap-2 py-0.5">
      <dt class="text-zinc-500">${label}</dt>
      <dd class="min-w-0 break-words text-zinc-300">${value}</dd>
    </div>
  `;
}

function names(list: readonly string[], prefix = ""): TemplateResult | null {
  if (list.length === 0) return null;
  return html`${list.map((name, index) => html`${index > 0 ? ", " : ""}<code class="font-mono text-[11px]">${prefix}${name}</code>`)}`;
}

function count(value: number): string | null {
  return value > 0 ? String(value) : null;
}

function group(title: string, body: TemplateResult) {
  return html`
    <section class="mt-6">
      <h3 class="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-400">${title}</h3>
      <dl class="text-xs">${body}</dl>
    </section>
  `;
}

/** Reins' page about one extension: its identity and health, what it gives agents and users, and its HTTP
 * methods and pages (its frontend part's, scripts' and callbacks' way in). Its migrations are not shown. Read-only. */
@customElement("settings-extension-details")
export class SettingsExtensionDetails extends LitElement {
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

  /** The extension's name, from the route. */
  @property({ attribute: false }) name = "";

  /** What agents get from it: all from its backend part. */
  private _renderForAgents(extension: ExtensionSummary) {
    const r = extension.backend?.registrations;
    if (!r || (!r.tools && r.promptSections === 0 && r.scriptFunctions.length === 0)) return nothing;
    return group("For agents", html`
      ${row("Tool providers", r.tools ? r.tools.title : null)}
      ${row("System prompt", r.promptSections > 0 ? (r.promptSections === 1 ? "1 section" : `${r.promptSections} sections`) : null)}
      ${row("API functions", names(r.scriptFunctions.map((name) => `api.${name}`)))}
    `);
  }

  /** What users get from it in the app: all from its frontend part. */
  private _renderInTheApp(extension: ExtensionSummary) {
    const r = extension.frontend?.registrations;
    if (!r || (r.views.length + r.commands.length + r.decorators + r.sidebarSections.length === 0 && !r.settingsPage)) return nothing;
    return group("In the app", html`
      ${row("Commands", names(r.commands, "/"))}
      ${row("Views", names(r.views))}
      ${row("Sidebar sections", names(r.sidebarSections))}
      ${row("Message decorators", count(r.decorators))}
      ${row("Settings page", r.settingsPage ? "Yes" : null)}
    `);
  }

  /** What its backend part hears of sessions: its listeners of the runs of the sessions it started. */
  private _renderSessions(extension: ExtensionSummary) {
    const listeners = extension.backend?.registrations.settlementListeners ?? 0;
    if (listeners === 0) return nothing;
    return group("Sessions", html`${row("Run ends heard", listeners === 1 ? "1 listener" : `${listeners} listeners`)}`);
  }

  /** Its backend part's HTTP methods and pages, by the paths a client calls. */
  private _renderHttp(extension: ExtensionSummary) {
    const r = extension.backend?.registrations;
    if (!r || r.httpMethods.length + r.pages.length === 0) return nothing;
    const paths = (list: readonly string[]) => list.length === 0
      ? null
      : html`${list.map((path) => html`<div><code class="font-mono text-[11px]">${path}</code></div>`)}`;
    return group("HTTP", html`
      ${row("Methods", paths(r.httpMethods.map((method) => `POST /api/extensions/${extension.name}/${method}`)))}
      ${row("Pages", paths(r.pages.map((page) => `GET ${page}`)))}
    `);
  }

  /** Its backend part's long-running work, each with its state as the host records it. */
  private _renderServices(extension: ExtensionSummary) {
    const services = extension.backend?.services ?? [];
    if (services.length === 0) return nothing;
    return group("Services", html`
      ${services.map((service) => {
        const details = [`since ${new Date(service.since).toLocaleString()}`];
        if (service.restarts > 0) details.push(service.restarts === 1 ? "1 restart" : `${service.restarts} restarts`);
        if (service.nextAttemptAt) details.push(`next attempt ${new Date(service.nextAttemptAt).toLocaleString()}`);
        return row(service.name, html`
          ${serviceState(service)} <span class="text-zinc-500">${details.join(", ")}</span>
          ${service.lastError ? html`<div class="break-words text-amber-400/90">Last error: ${service.lastError.message}</div>` : nothing}
        `);
      })}
    `);
  }

  private _renderStorage(extension: ExtensionSummary) {
    const storage = extension.backend?.storage;
    if (!storage) return nothing;
    return group("Storage", html`
      ${row("Data directory", html`<code class="font-mono text-[11px] select-all">${storage.dataDir}</code>`)}
      ${row("Database", formatBytes(storage.databaseBytes))}
      ${row("Secrets", storage.secrets === 0 ? "None" : String(storage.secrets))}
    `);
  }

  private _renderErrors(extension: ExtensionSummary) {
    const errors = extension.backend?.errors ?? [];
    if (errors.length === 0) return nothing;
    return group("Recent errors", html`
      <ul class="space-y-0.5">
        ${errors.toReversed().map((error) => html`
          <li class="text-amber-400/90"><span class="text-zinc-500">${new Date(error.at).toLocaleString()}</span> ${error.message}</li>
        `)}
      </ul>
    `);
  }

  private _renderBack() {
    return html`
      <button
        type="button"
        class="mb-4 flex cursor-pointer items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
        @click=${() => showSettingsSection("extensions")}
      >${chevronLeftIcon("", 14)}Extensions</button>
    `;
  }

  private _renderExtension(extension: ExtensionSummary) {
    const failed = extension.status === "failed";
    return html`
      <header class="flex items-center gap-2">
        ${extension.icon
          ? html`<reins-view-mount class="block size-4 shrink-0 overflow-hidden" aria-hidden="true" .presentation=${extension.icon}></reins-view-mount>`
          : nothing}
        <h2 class="truncate text-base font-semibold text-zinc-100">${extension.label}</h2>
        ${extension.label !== extension.name ? html`<code class="truncate font-mono text-xs text-zinc-500">${extension.name}</code>` : nothing}
        <span class="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-zinc-400">${statusDot(failed ? "danger" : "success")}${failed ? "failed" : "loaded"}</span>
      </header>
      ${extension.description ? html`<p class="mt-1 text-xs text-zinc-500">${extension.description}</p>` : nothing}
      ${extension.problems.map((problem) => html`<p class="mt-3 text-xs text-red-400/90 break-words" role="status">${problem}</p>`)}
      ${extension.frontend?.registrations.settingsPage
        ? html`<button
            type="button"
            class="mt-3 cursor-pointer rounded bg-zinc-700 px-2.5 py-1.5 text-xs text-zinc-100 hover:bg-zinc-600"
            @click=${() => showSettingsExtension(extension.name)}
          >Open its settings</button>`
        : nothing}
      ${this._renderForAgents(extension)}
      ${this._renderInTheApp(extension)}
      ${this._renderForAgents(extension) === nothing && this._renderInTheApp(extension) === nothing
        ? html`<p class="mt-6 text-xs text-zinc-500">It gives agents and users nothing now.</p>`
        : nothing}
      ${this._renderServices(extension)}
      ${this._renderSessions(extension)}
      ${this._renderHttp(extension)}
      ${this._renderStorage(extension)}
      ${this._renderErrors(extension)}
    `;
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;
    const extension = store.extensions.find((candidate) => candidate.name === this.name);
    let body: TemplateResult;
    if (extension) body = this._renderExtension(extension);
    else if (store.backend.data || store.backendError) body = html`<p class="py-4 text-sm text-zinc-400">No extension named “${this.name}”.</p>`;
    else body = html`<div class="py-2 text-xs text-zinc-500">Loading extension...</div>`;
    return html`
      ${this._renderBack()}
      ${store.backendError
        ? html`<p class="mb-3 text-xs text-amber-400/90" role="status">Could not load the server's extensions: ${store.backendError}</p>`
        : nothing}
      ${body}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-extension-details": SettingsExtensionDetails;
  }
}
