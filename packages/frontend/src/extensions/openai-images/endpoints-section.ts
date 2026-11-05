import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { draftOf, emptyDraft, type EndpointDraft, type EndpointsStore, type EndpointView } from "./endpoints-store.js";
import { confirmDialog } from "../../ui/confirm-dialog.js";
import { dialogButton } from "../../ui/dialog.js";
import "../../ui/popover-menu.js";
import { showToast } from "../../ui/toast.js";

const INPUT_CLASSES = "w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors";
const LABEL_CLASSES = "block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1";
const MENU_ITEM = "w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-700 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default";

/** The openai-images Settings page: the endpoints whose models agents get through `api.images`. */
@customElement("settings-openai-images-section")
export class SettingsOpenAiImagesSection extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _storeCtrl = new StoreController<EndpointsStore>(this);

  @property({ attribute: false })
  set store(store: EndpointsStore | null) {
    this._storeCtrl.store = store;
  }

  get store(): EndpointsStore | null {
    return this._storeCtrl.store;
  }

  /** The form: a new endpoint (`id` null) or one being edited. */
  @state() private _editing: { id: number | null; draft: EndpointDraft } | null = null;

  override disconnectedCallback() {
    this._editing = null;
    super.disconnectedCallback();
  }

  private _openAdd = () => {
    this._editing = { id: null, draft: emptyDraft() };
  };

  private _closeForm = () => {
    this._editing = null;
  };

  private _set(field: Exclude<keyof EndpointDraft, "randomSeed">, value: string) {
    if (this._editing) this._editing = { ...this._editing, draft: { ...this._editing.draft, [field]: value } };
  }

  private _save = async () => {
    const store = this.store;
    const editing = this._editing;
    if (!store || !editing || store.creating || (editing.id !== null && store.actions.has(editing.id))) return;
    const result = editing.id === null ? await store.create(editing.draft) : await store.update(editing.id, editing.draft);
    if ("error" in result) {
      showToast(`Failed to save the endpoint: ${result.error}`, "error");
      return;
    }
    this._editing = null;
  };

  private async _run(label: string, work: () => Promise<{ ok: true } | { error: string }>) {
    const result = await work();
    if ("error" in result) showToast(`${label}: ${result.error}`, "error");
  }

  private async _remove(endpoint: EndpointView) {
    const store = this.store;
    if (!store) return;
    const confirmed = await confirmDialog({
      title: `Remove ${endpoint.name}?`,
      message: "Reins forgets this endpoint and its API key. Agents can no longer use its models.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (confirmed) await this._run("Failed to remove the endpoint", () => store.remove(endpoint.id));
  }

  private _renderMenu(endpoint: EndpointView, store: EndpointsStore) {
    const busy = store.actions.has(endpoint.id);
    return html`
      <popover-menu
        close-on-panel-click
        triggerClass="!px-1 !py-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/60"
        .content=${() => html`
          <button class="${MENU_ITEM} text-zinc-300" ?disabled=${busy} @click=${() => void this._run(`Failed to test ${endpoint.name}`, () => store.test(endpoint.id))}>Test</button>
          <button class="${MENU_ITEM} text-zinc-300" @click=${() => { this._editing = { id: endpoint.id, draft: draftOf(endpoint) }; }}>Edit</button>
          ${endpoint.hasApiKey
            ? html`<button class="${MENU_ITEM} text-zinc-300" ?disabled=${busy} @click=${() => void this._run(`Failed to change ${endpoint.name}`, () => store.clearApiKey(endpoint.id))}>Remove API key</button>`
            : nothing}
          <button class="${MENU_ITEM} text-red-400" ?disabled=${busy} @click=${() => void this._remove(endpoint)}>Remove</button>
        `}
      ></popover-menu>
    `;
  }

  private _renderTest(endpoint: EndpointView, store: EndpointsStore) {
    if (store.actions.get(endpoint.id) === "testing") return html`<p class="mt-2 text-xs text-zinc-500" role="status">Testing…</p>`;
    const test = store.tests.get(endpoint.id);
    if (!test) return nothing;
    if ("error" in test) return html`<p class="mt-2 rounded-md bg-red-950/40 border border-red-900/50 px-3 py-2 text-xs text-red-200/90 break-words" role="status">${test.error}</p>`;
    return html`<p class="mt-2 text-xs text-green-400/90 break-words" role="status">The server lists ${test.models.length ? test.models.join(", ") : "no models"}.</p>`;
  }

  private _renderEndpoint(endpoint: EndpointView, store: EndpointsStore) {
    const parameters = Object.keys(endpoint.defaultParameters).length > 0 ? JSON.stringify(endpoint.defaultParameters) : null;
    return html`
      <li class="rounded-lg border border-zinc-700/70 bg-zinc-800/40 p-3">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium text-zinc-100 truncate">${endpoint.name}</span>
          ${endpoint.hasApiKey ? html`<span class="text-[10px] text-zinc-400 bg-zinc-700/60 px-1.5 py-0.5 rounded shrink-0">API key</span>` : nothing}
          <span class="ml-auto flex items-center gap-2 shrink-0">${this._renderMenu(endpoint, store)}</span>
        </div>
        <p class="mt-1 text-xs text-zinc-500 font-mono truncate" title=${endpoint.baseUrl}>${endpoint.baseUrl}</p>
        <p class="mt-1 text-xs text-zinc-400 break-words">Models: ${endpoint.models ? endpoint.models.join(", ") : "every model the server lists"}</p>
        ${parameters ? html`<p class="mt-1 text-xs text-zinc-500 font-mono break-all">Default parameters: ${parameters}</p>` : nothing}
        ${endpoint.randomSeed ? html`<p class="mt-1 text-xs text-zinc-400">Random seed for each request</p>` : nothing}
        ${this._renderTest(endpoint, store)}
      </li>
    `;
  }

  private _field(label: string, field: Exclude<keyof EndpointDraft, "randomSeed">, options: { placeholder?: string; type?: "text" | "password" | "url"; autofocus?: boolean; rows?: number } = {}) {
    const draft = this._editing?.draft;
    if (!draft) return nothing;
    if (options.rows) {
      return html`
        <label class="block">
          <span class=${LABEL_CLASSES}>${label}</span>
          <textarea
            aria-label=${label}
            rows=${options.rows}
            spellcheck="false"
            placeholder=${options.placeholder ?? ""}
            class="${INPUT_CLASSES} font-mono resize-y"
            @input=${(e: Event) => { if (e.target instanceof HTMLTextAreaElement) this._set(field, e.target.value); }}
            .value=${draft[field]}
          ></textarea>
        </label>
      `;
    }
    return html`
      <label class="block">
        <span class=${LABEL_CLASSES}>${label}</span>
        <input
          aria-label=${label}
          type=${options.type ?? "text"}
          ?autofocus=${options.autofocus ?? false}
          autocomplete="off"
          spellcheck="false"
          placeholder=${options.placeholder ?? ""}
          class=${INPUT_CLASSES}
          @input=${(e: Event) => { if (e.target instanceof HTMLInputElement) this._set(field, e.target.value); }}
          .value=${draft[field]}
        />
      </label>
    `;
  }

  private _renderRandomSeed(on: boolean) {
    return html`
      <div class="flex items-start gap-3">
        <button
          type="button"
          role="switch"
          aria-checked=${on ? "true" : "false"}
          class="relative mt-0.5 inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors ${on ? "bg-blue-600" : "bg-zinc-600"}"
          @click=${() => { if (this._editing) this._editing = { ...this._editing, draft: { ...this._editing.draft, randomSeed: !on } }; }}
        ><span class="sr-only">Random seed</span><span class="inline-block h-3 w-3 rounded-full bg-white transition-transform ${on ? "translate-x-3.5" : "translate-x-0.5"}" aria-hidden="true"></span></button>
        <div>
          <span class=${LABEL_CLASSES}>Random seed</span>
          <p class="text-[10px] text-zinc-500">Send a new random seed with each request that has none. For servers that use the same seed each time, such as SGLang. Leave it off for OpenAI, which does not accept a seed.</p>
        </div>
      </div>
    `;
  }

  private _renderForm(store: EndpointsStore) {
    const editing = this._editing;
    const existing = editing?.id != null ? store.endpoints.data?.find(endpoint => endpoint.id === editing.id) ?? null : null;
    const draft = editing?.draft;
    const saving = editing !== null && (editing.id === null ? store.creating : store.actions.get(editing.id) === "saving");
    return html`
      <app-dialog
        .open=${editing !== null}
        heading=${existing ? `Edit ${existing.name}` : "Add image endpoint"}
        .onSubmit=${() => void this._save()}
        .body=${draft ? html`
          <div class="space-y-3">
            ${this._field("Name", "name", { placeholder: "william-pc", autofocus: true })}
            <p class="-mt-2 text-[10px] text-zinc-500">Lowercase letters, digits and hyphens. Model IDs start with it: &lt;name&gt;/&lt;model&gt;.</p>
            ${this._field("Base URL", "baseUrl", { placeholder: "https://api.openai.com/v1", type: "url" })}
            ${this._field("API key", "apiKey", { type: "password", placeholder: existing?.hasApiKey ? "Saved (leave blank to keep it)" : "None" })}
            ${this._field("Models", "models", { rows: 2, placeholder: "Every model the server lists" })}
            <p class="-mt-2 text-[10px] text-zinc-500">One a line. Leave blank to use every model of GET /models.</p>
            ${this._field("Default parameters", "defaultParameters", { rows: 3, placeholder: "{ \"output_format\": \"png\" }" })}
            <p class="-mt-2 text-[10px] text-zinc-500">A JSON object added to each request. SGLang's Qwen-Image server needs { "output_format": "png" }.</p>
            ${this._renderRandomSeed(draft.randomSeed)}
          </div>
        ` : nothing}
        .actions=${html`
          ${dialogButton({ label: "Cancel", onClick: this._closeForm })}
          ${dialogButton({ label: saving ? "Saving..." : "Save", variant: "primary", type: "submit", disabled: saving || !draft?.name.trim() || !draft?.baseUrl.trim() })}
        `}
        @dialog-cancel=${this._closeForm}
      ></app-dialog>
    `;
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;
    const endpoints = store.endpoints.data;
    return html`
      <div class="space-y-3">
        <p class="text-xs text-zinc-400">OpenAI-compatible image APIs (OpenAI, SGLang). Agents make images with their models through api.images.</p>
        ${endpoints
          ? endpoints.length
            ? html`<ul class="space-y-2" aria-label="Image endpoints">${endpoints.map(endpoint => this._renderEndpoint(endpoint, store))}</ul>`
            : html`<p class="text-xs text-zinc-500 py-2">No image endpoints yet.</p>`
          : store.endpoints.loading ? html`<div class="text-xs text-zinc-500 py-2">Loading image endpoints...</div>` : nothing}
        <button
          class="px-2.5 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors"
          @click=${this._openAdd}
        >Add image endpoint</button>
      </div>
      ${this._renderForm(store)}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-openai-images-section": SettingsOpenAiImagesSection;
  }
}
