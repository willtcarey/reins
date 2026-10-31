import type { McpServerView } from "@backend/extensions/mcp/servers.js";
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import {
  draftOf, emptyDraft, mayTest, needsSignIn, statusLabel, type McpAuthKind, type McpServerDraft, type McpServersStore,
  type McpTransportKind,
} from "./mcp-servers-store.js";
import { chevronDownIcon, chevronRightIcon } from "../../ui/icons.js";
import { confirmDialog } from "../../ui/confirm-dialog.js";
import { dialogButton } from "../../ui/dialog.js";
import "../../ui/popover-menu.js";
import { showToast } from "../../components/toast.js";

const STATUS_DOTS: Record<McpServerView["status"]["state"], string> = {
  ready: "bg-green-500",
  needs_sign_in: "bg-amber-400",
  error: "bg-red-500",
  disabled: "bg-zinc-700",
};
const TESTING_DOT = "bg-blue-400 motion-safe:animate-pulse";

const AUTH_KINDS: ReadonlyArray<{ kind: McpAuthKind; label: string; hint: string }> = [
  { kind: "oauth", label: "OAuth", hint: "Sign in with the server's own login. Reins registers itself unless you give a client ID." },
  { kind: "header", label: "Header", hint: "Send a fixed header, such as an API key, with every request." },
  { kind: "none", label: "None", hint: "The server needs no authentication." },
];

const TRANSPORT_KINDS: ReadonlyArray<{ kind: McpTransportKind; label: string }> = [
  { kind: "http", label: "Streamable HTTP" },
  { kind: "sse", label: "HTTP+SSE (legacy)" },
];

const INPUT_CLASSES = "w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors";
const ROW_BUTTON = "px-2.5 py-1 text-xs rounded-md border cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default";
const MENU_ITEM = "w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-700 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default";

/**
 * Opens the sign-in window, blank, while the click is still running: browsers (Safari, Firefox) block a
 * popup opened after an await. The server's callback page closes it once done. Null when blocked.
 */
function openSignInWindow(): Window | null {
  return globalThis.open?.("", "_blank", "popup,width=520,height=720") ?? null;
}

/** A secret field's placeholder: the server has one, which a blank field keeps. */
function kept(has: boolean | undefined): string {
  return has ? "Saved (leave blank to keep it)" : "";
}

/** Whether a text is likely longer than its 3 clamped lines: measuring the DOM would be exact but needs layout. */
function isLong(text: string): boolean {
  return text.length > 200 || text.split("\n").length > 3;
}

@customElement("settings-mcp-servers-section")
export class SettingsMcpServersSection extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _storeCtrl = new StoreController<McpServersStore>(this);

  @property({ attribute: false })
  set store(store: McpServersStore | null) {
    this._storeCtrl.store = store;
  }

  get store(): McpServersStore | null {
    return this._storeCtrl.store;
  }

  /** The form: a new server (`id` null) or one being edited. */
  @state() private _editing: { id: number | null; draft: McpServerDraft; advanced: boolean } | null = null;

  /** The texts shown whole: a server's instructions as `<server id>`, a tool's description as
   * `<server id>:<tool name>`. */
  @state() private _expanded = new Set<string>();

  private _toggleExpanded(key: string) {
    const expanded = new Set(this._expanded);
    if (!expanded.delete(key)) expanded.add(key);
    this._expanded = expanded;
  }

  /** `text` cut to 3 lines until Show more. */
  private _renderClamped(key: string, text: string | undefined, classes: string) {
    if (!text) return nothing;
    const long = isLong(text);
    const expanded = this._expanded.has(key);
    return html`
      <p class="${classes} whitespace-pre-line break-words ${long && !expanded ? "line-clamp-3" : ""}">${text}</p>
      ${long ? html`<button
        class="mt-0.5 text-xs text-zinc-400 underline decoration-dotted underline-offset-2 hover:text-zinc-200 hover:decoration-solid cursor-pointer transition-colors"
        aria-expanded=${expanded ? "true" : "false"}
        @click=${() => this._toggleExpanded(key)}
      >${expanded ? "Show less" : "Show more"}</button>` : nothing}
    `;
  }

  override disconnectedCallback() {
    this._editing = null;
    this.store?.cancelSignIn();
    super.disconnectedCallback();
  }

  private _openAdd = () => {
    this._editing = { id: null, draft: emptyDraft(), advanced: false };
  };

  private _openEdit(server: McpServerView) {
    this._editing = { id: server.id, draft: draftOf(server), advanced: server.transport !== "http" || server.oauthClientId !== null || server.oauthScope !== null };
  }

  private _closeForm = () => {
    this._editing = null;
  };

  private _set<K extends keyof McpServerDraft>(field: K, value: McpServerDraft[K]) {
    if (this._editing) this._editing = { ...this._editing, draft: { ...this._editing.draft, [field]: value } };
  }

  private _save = async () => {
    const store = this.store;
    const editing = this._editing;
    if (!store || !editing || store.creating || (editing.id !== null && store.actions.has(editing.id))) return;
    const result = editing.id === null ? await store.create(editing.draft) : await store.update(editing.id, editing.draft);
    if ("error" in result) {
      showToast(`Failed to save MCP server: ${result.error}`, "error");
      return;
    }
    this._editing = null;
  };

  private async _signIn(server: McpServerView) {
    const store = this.store;
    if (!store) return;
    const popup = openSignInWindow();
    const result = await store.startSignIn(server.id);
    if ("error" in result) {
      popup?.close();
      showToast(`Failed to start signing in to ${server.name}: ${result.error}`, "error");
      return;
    }
    if (!popup) return;
    // The authorization page needs no way back to this tab (it could navigate it through `opener`).
    popup.opener = null;
    popup.location.href = result.authorizationUrl;
  }

  private async _run(label: string, work: () => Promise<{ ok: true } | { error: string }>) {
    const result = await work();
    if ("error" in result) showToast(`${label}: ${result.error}`, "error");
  }

  private async _remove(server: McpServerView) {
    const store = this.store;
    if (!store) return;
    const confirmed = await confirmDialog({
      title: `Remove ${server.name}?`,
      message: "Reins forgets this server and its credentials. Add it again to use it.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (confirmed) await this._run("Failed to remove MCP server", () => store.remove(server.id));
  }

  private _renderSwitch(server: McpServerView, store: McpServersStore) {
    const label = `${server.enabled ? "Disable" : "Enable"} ${server.name}`;
    return html`
      <button
        type="button"
        role="switch"
        aria-checked=${server.enabled ? "true" : "false"}
        title=${label}
        class="relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${server.enabled ? "bg-blue-600" : "bg-zinc-600"}"
        ?disabled=${store.actions.has(server.id)}
        @click=${() => void this._run("Failed to change MCP server", () => store.setEnabled(server.id, !server.enabled))}
      ><span class="sr-only">${label}</span><span class="inline-block h-3 w-3 rounded-full bg-white transition-transform ${server.enabled ? "translate-x-3.5" : "translate-x-0.5"}" aria-hidden="true"></span></button>
    `;
  }

  private _renderSignInButton(server: McpServerView, store: McpServersStore) {
    if (!needsSignIn(server)) return nothing;
    const action = store.actions.get(server.id);
    return html`<button class="${ROW_BUTTON} border-blue-500/60 bg-blue-600/20 text-blue-200 hover:bg-blue-600/40" ?disabled=${action !== undefined} @click=${() => void this._signIn(server)}>${action === "signing-in" ? "Starting…" : "Sign in"}</button>`;
  }

  private _renderMenu(server: McpServerView, store: McpServersStore) {
    const busy = store.actions.has(server.id);
    return html`
      <popover-menu
        close-on-panel-click
        triggerClass="!px-1 !py-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/60"
        .content=${() => html`
          ${mayTest(server)
            ? html`<button class="${MENU_ITEM} text-zinc-300" ?disabled=${busy} @click=${() => void this._run(`Failed to test ${server.name}`, () => store.test(server.id))}>Test</button>`
            : nothing}
          <button class="${MENU_ITEM} text-zinc-300" @click=${() => this._openEdit(server)}>Edit</button>
          ${server.authKind === "oauth" && server.signedIn
            ? html`<button class="${MENU_ITEM} text-zinc-300" ?disabled=${busy} @click=${() => void this._run(`Failed to sign out of ${server.name}`, () => store.signOut(server.id))}>Sign out</button>`
            : nothing}
          <button class="${MENU_ITEM} text-red-400" ?disabled=${busy} @click=${() => void this._remove(server)}>Remove</button>
        `}
      ></popover-menu>
    `;
  }

  private _renderSignInWaiting(store: McpServersStore, server: McpServerView) {
    const signIn = store.signIn;
    if (signIn?.serverId !== server.id) return nothing;
    return html`
      <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-zinc-200" role="status">
        <span>Finish signing in to ${server.name} in the window that opened.</span>
        <a href=${signIn.authorizationUrl} target="_blank" rel="noopener" class="text-blue-400 hover:text-blue-300 underline">Open the sign-in page</a>
        <button class="ml-auto text-zinc-400 hover:text-zinc-200 cursor-pointer" @click=${() => store.cancelSignIn()}>Cancel</button>
      </div>
    `;
  }

  private _renderToolsToggle(server: McpServerView, store: McpServersStore) {
    const shown = store.tools.has(server.id);
    return html`
      <button
        class="flex items-center gap-0.5 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
        aria-expanded=${shown ? "true" : "false"}
        @click=${() => store.toggleTools(server.id)}
      >${shown ? chevronDownIcon("", 12) : chevronRightIcon("", 12)}<span>Tools</span></button>
    `;
  }

  private _renderTools(server: McpServerView, store: McpServersStore) {
    const tools = store.tools.get(server.id);
    if (!tools) return nothing;
    return html`
      <div class="mt-3 border-t border-zinc-700/60 pt-3 space-y-1.5 text-xs">
        ${tools.loading && !tools.data ? html`<p class="text-zinc-500">Listing tools…</p>` : nothing}
        ${tools.error ? html`<p class="text-amber-400/90 break-words">Can't list tools: ${tools.error}</p>` : nothing}
        ${tools.data?.length === 0 ? html`<p class="text-zinc-500">No tools</p>` : nothing}
        ${tools.data?.length ? html`
          <ul class="space-y-2" aria-label="${server.name} tools">
            ${tools.data.map(tool => html`
              <li>
                <p class="font-mono text-zinc-200 break-all">${tool.name}</p>
                ${this._renderClamped(`${server.id}:${tool.name}`, tool.description, "mt-0.5 text-zinc-500")}
              </li>
            `)}
          </ul>
        ` : nothing}
      </div>
    `;
  }

  private _renderServer(server: McpServerView, store: McpServersStore) {
    const status = server.status;
    const testing = store.actions.get(server.id) === "testing";
    const warning = !testing && (status.state === "error" || status.state === "needs_sign_in");
    return html`
      <li class="rounded-lg border border-zinc-700/70 bg-zinc-800/40 p-3 ${server.enabled ? "" : "opacity-70"}">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium text-zinc-100 truncate">${server.name}</span>
          <span class="text-[10px] text-zinc-400 bg-zinc-700/60 px-1.5 py-0.5 rounded shrink-0">${server.authKind === "none" ? "no auth" : server.authKind}</span>
          ${server.transport === "http" ? nothing : html`<span class="text-[10px] text-zinc-400 bg-zinc-700/60 px-1.5 py-0.5 rounded shrink-0">${server.transport}</span>`}
          <span class="ml-auto flex items-center gap-2 shrink-0">
            ${this._renderSignInButton(server, store)}
            ${this._renderSwitch(server, store)}
            ${this._renderMenu(server, store)}
          </span>
        </div>
        ${this._renderClamped(String(server.id), server.instructions, "mt-1 text-xs text-zinc-400")}
        <p class="mt-1 text-xs text-zinc-500 font-mono truncate" title=${server.url}>${server.url}</p>
        <div class="mt-2 flex items-center gap-3 text-xs">
          <span class="flex items-center gap-1.5 ${warning ? "text-amber-400/90" : "text-zinc-400"}">
            <span class="w-2 h-2 rounded-full shrink-0 ${testing ? TESTING_DOT : STATUS_DOTS[status.state]}" aria-hidden="true"></span>${testing ? "testing…" : statusLabel(status)}
          </span>
          ${server.enabled ? this._renderToolsToggle(server, store) : nothing}
        </div>
        ${status.state === "error" ? html`<p class="mt-2 rounded-md bg-red-950/40 border border-red-900/50 px-3 py-2 text-xs text-red-200/90 break-words">${status.message}</p>` : nothing}
        ${this._renderSignInWaiting(store, server)}
        ${server.enabled ? this._renderTools(server, store) : nothing}
      </li>
    `;
  }

  private _field(label: string, field: Exclude<keyof McpServerDraft, "authKind" | "transport">, options: { placeholder?: string; type?: "text" | "password" | "url"; autofocus?: boolean } = {}) {
    const draft = this._editing?.draft;
    if (!draft) return nothing;
    return html`
      <label class="block">
        <span class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1">${label}</span>
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

  /** A labelled row of choices, one of them checked. */
  private _radioGroup<K extends string>(label: string, options: ReadonlyArray<{ kind: K; label: string }>, checked: K, choose: (kind: K) => void) {
    return html`
      <span class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1">${label}</span>
      <div class="flex gap-1" role="radiogroup" aria-label=${label}>
        ${options.map(option => html`
          <button
            type="button"
            role="radio"
            aria-checked=${checked === option.kind ? "true" : "false"}
            class="px-2.5 py-1 text-xs rounded cursor-pointer transition-colors ${checked === option.kind ? "bg-zinc-600 text-zinc-100" : "text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"}"
            @click=${() => choose(option.kind)}
          >${option.label}</button>
        `)}
      </div>
    `;
  }

  private _renderForm(store: McpServersStore) {
    const editing = this._editing;
    const existing = editing?.id != null ? store.servers.data?.find(server => server.id === editing.id) ?? null : null;
    const draft = editing?.draft;
    const saving = editing !== null && (editing.id === null ? store.creating : store.actions.get(editing.id) === "saving");

    return html`
      <app-dialog
        .open=${editing !== null}
        heading=${existing ? `Edit ${existing.name}` : "Add MCP server"}
        .onSubmit=${() => void this._save()}
        .body=${draft ? html`
          <div class="space-y-3">
            ${this._field("Name", "name", { placeholder: "executor", autofocus: true })}
            <p class="-mt-2 text-[10px] text-zinc-500">Lowercase letters, digits and hyphens. Agents name the server by it.</p>
            <label class="block">
              <span class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1">Instructions</span>
              <textarea
                aria-label="Instructions"
                rows="5"
                spellcheck="false"
                placeholder="What its tools are for and how to use them"
                class="${INPUT_CLASSES} resize-y"
                @input=${(e: Event) => { if (e.target instanceof HTMLTextAreaElement) this._set("instructions", e.target.value); }}
                .value=${draft.instructions}
              ></textarea>
            </label>
            <p class="-mt-2 text-[10px] text-zinc-500">Agents are given these in their system prompt, under the server's name, in every session. Keep them short.</p>
            ${this._field("URL", "url", { placeholder: "https://example.com/mcp", type: "url" })}
            <div>
              ${this._radioGroup("Authentication", AUTH_KINDS, draft.authKind, kind => this._set("authKind", kind))}
              <p class="mt-1 text-[10px] text-zinc-500">${AUTH_KINDS.find(option => option.kind === draft.authKind)?.hint}</p>
            </div>
            ${draft.authKind === "header" ? html`
              ${this._field("Header name", "headerName", { placeholder: "Authorization" })}
              ${this._field("Header value", "headerValue", { type: "password", placeholder: kept(existing?.hasHeaderValue) })}
            ` : nothing}
            <button
              type="button"
              class="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors flex items-center gap-1"
              aria-expanded=${editing!.advanced ? "true" : "false"}
              @click=${() => { if (this._editing) this._editing = { ...this._editing, advanced: !this._editing.advanced }; }}
            >${editing!.advanced ? chevronDownIcon("", 12) : chevronRightIcon("", 12)}<span>Advanced</span></button>
            ${editing!.advanced ? html`
              <div>
                ${this._radioGroup("Transport", TRANSPORT_KINDS, draft.transport, kind => this._set("transport", kind))}
                <p class="mt-1 text-[10px] text-zinc-500">HTTP+SSE is for older servers that do not support streamable HTTP.</p>
              </div>
              ${draft.authKind === "oauth" ? html`
                <p class="text-[10px] text-zinc-500">For a server that needs a client registered with it beforehand (Slack): its redirect URL is ${location.origin}/extensions/mcp/oauth/callback.</p>
                ${this._field("Client ID", "oauthClientId")}
                ${this._field("Client secret", "oauthClientSecret", { type: "password", placeholder: kept(existing?.hasClientSecret) })}
                ${this._field("Scope", "oauthScope", { placeholder: "The server's own when blank" })}
              ` : nothing}
            ` : nothing}
          </div>
        ` : nothing}
        .actions=${html`
          ${dialogButton({ label: "Cancel", onClick: this._closeForm })}
          ${dialogButton({ label: saving ? "Saving..." : "Save", variant: "primary", type: "submit", disabled: saving || !draft?.name.trim() || !draft?.url.trim() })}
        `}
        @dialog-cancel=${this._closeForm}
      ></app-dialog>
    `;
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;
    const servers = store.servers.data;

    return html`
      <div class="space-y-3">
        ${servers
          ? servers.length
            ? html`<ul class="space-y-2" aria-label="MCP servers">${servers.map(server => this._renderServer(server, store))}</ul>`
            : html`<p class="text-xs text-zinc-500 py-2">No MCP servers yet.</p>`
          : store.servers.loading ? html`<div class="text-xs text-zinc-500 py-2">Loading MCP servers...</div>` : nothing}
        <button
          class="px-2.5 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors"
          @click=${this._openAdd}
        >Add MCP server</button>
      </div>
      ${this._renderForm(store)}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-mcp-servers-section": SettingsMcpServersSection;
  }
}
