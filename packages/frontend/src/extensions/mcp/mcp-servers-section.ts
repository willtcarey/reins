import type { McpServerView } from "@backend/extensions/mcp/servers.js";
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import {
  commandLine, draftOf, emptyDraft, mayTest, needsSignIn, type McpAuthKind, type McpEnvDraft, type McpServerDraft,
  type McpServersStore, type McpTransportKind,
} from "./mcp-servers-store.js";
import { chevronDownIcon, chevronRightIcon, closeIcon } from "../../ui/icons.js";
import { confirmDialog } from "../../ui/confirm-dialog.js";
import { dialogButton } from "../../ui/dialog.js";
import "../../ui/popover-menu.js";
import { showToast } from "../../ui/toast.js";
import { ClampedTexts, mcpServerCard, openSignInWindow, showSignInPage } from "./server-card.js";

const AUTH_KINDS: ReadonlyArray<{ kind: McpAuthKind; label: string; hint: string }> = [
  { kind: "oauth", label: "OAuth", hint: "Sign in with the server's own login. Reins registers itself unless you give a client ID." },
  { kind: "header", label: "Header", hint: "Send a fixed header, such as an API key, with every request." },
  { kind: "none", label: "None", hint: "The server needs no authentication." },
];

const TRANSPORT_KINDS: ReadonlyArray<{ kind: McpTransportKind; label: string }> = [
  { kind: "http", label: "Streamable HTTP" },
  { kind: "sse", label: "HTTP+SSE (legacy)" },
];

type McpServerKind = "remote" | "stdio";
const SERVER_KINDS: ReadonlyArray<{ kind: McpServerKind; label: string }> = [
  { kind: "remote", label: "Remote (URL)" },
  { kind: "stdio", label: "Command (stdio)" },
];

const INPUT_CLASSES = "w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors";
const MENU_ITEM = "w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-700 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default";

/** A secret field's placeholder: the server has one, which a blank field keeps. */
function kept(has: boolean | undefined): string {
  return has ? "Saved (leave blank to keep it)" : "";
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

  /** The texts shown whole: a server's instructions as `<server id>`, a tool's description as
   * `<server id>:<tool name>`. */
  private readonly _clamped = new ClampedTexts(this);
  /** The form: a new server (`id` null) or one being edited. */
  @state() private _editing: { id: number | null; draft: McpServerDraft; advanced: boolean } | null = null;

  override disconnectedCallback() {
    this._editing = null;
    this.store?.cancelSignIn();
    super.disconnectedCallback();
  }

  private _openAdd = () => {
    this._editing = { id: null, draft: emptyDraft(), advanced: false };
  };

  private _openEdit(server: McpServerView) {
    const advanced = server.transport !== "stdio" && (server.transport === "sse" || server.oauthClientId !== null || server.oauthScope !== null);
    this._editing = { id: server.id, draft: draftOf(server), advanced };
  }

  private _closeForm = () => {
    this._editing = null;
  };

  private _set<K extends keyof McpServerDraft>(field: K, value: McpServerDraft[K]) {
    if (this._editing) this._editing = { ...this._editing, draft: { ...this._editing.draft, [field]: value } };
  }

  /** Remote servers are reached over HTTP (or SSE); a stdio server is a command, with no sign-in. */
  private _setKind(kind: McpServerKind) {
    const draft = this._editing?.draft;
    if (!draft || (kind === "stdio") === (draft.transport === "stdio")) return;
    this._set("transport", kind === "stdio" ? "stdio" : "http");
  }

  private _setEnv(index: number, change: Partial<McpEnvDraft> | null) {
    const env = this._editing?.draft.env;
    if (!env) return;
    this._set("env", change === null ? env.filter((_, i) => i !== index) : env.map((row, i) => i === index ? { ...row, ...change } : row));
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
    showSignInPage(popup, result.authorizationUrl);
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
          ${server.transport !== "stdio" && server.authKind === "oauth" && server.signedIn
            ? html`<button class="${MENU_ITEM} text-zinc-300" ?disabled=${busy} @click=${() => void this._run(`Failed to sign out of ${server.name}`, () => store.signOut(server.id))}>Sign out</button>`
            : nothing}
          <button class="${MENU_ITEM} text-red-400" ?disabled=${busy} @click=${() => void this._remove(server)}>Remove</button>
        `}
      ></popover-menu>
    `;
  }

  private _renderServer(server: McpServerView, store: McpServersStore) {
    const action = store.actions.get(server.id);
    const busy = action !== undefined;
    const signIn = store.signIn;
    return mcpServerCard({
      id: server.id,
      name: server.name,
      transport: server.transport,
      ...(server.transport === "stdio" ? {} : { authKind: server.authKind }),
      where: server.transport === "stdio" ? commandLine(server) : server.url,
      instructions: server.instructions,
      status: server.status,
      testing: action === "testing",
      toggle: {
        on: server.enabled,
        label: `${server.enabled ? "Disable" : "Enable"} ${server.name}`,
        busy,
        flip: () => void this._run("Failed to change MCP server", () => store.setEnabled(server.id, !server.enabled)),
      },
      signIn: needsSignIn(server) ? { busy, label: action === "signing-in" ? "Starting…" : "Sign in", start: () => void this._signIn(server) } : null,
      menu: this._renderMenu(server, store),
      signingIn: signIn?.serverId === server.id ? { authorizationUrl: signIn.authorizationUrl, cancel: () => store.cancelSignIn() } : null,
      tools: { available: server.enabled, shown: store.tools.get(server.id), toggle: () => store.toggleTools(server.id) },
    }, this._clamped);
  }

  private _field(label: string, field: Exclude<keyof McpServerDraft, "authKind" | "transport" | "env">, options: { placeholder?: string; type?: "text" | "password" | "url"; autofocus?: boolean } = {}) {
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

  /** A stdio server's environment: a row per variable, its value masked (blank keeps a saved one). */
  private _renderEnv(env: readonly McpEnvDraft[], saved: readonly string[]) {
    return html`
      <div>
        <span class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1">Environment</span>
        <div class="space-y-1.5">
          ${env.map((row, index) => html`
            <div class="flex gap-1.5 items-center">
              <input
                aria-label=${`Variable ${index + 1} name`}
                autocomplete="off"
                spellcheck="false"
                placeholder="NAME"
                class="${INPUT_CLASSES} font-mono flex-1"
                @input=${(e: Event) => { if (e.target instanceof HTMLInputElement) this._setEnv(index, { name: e.target.value }); }}
                .value=${row.name}
              />
              <input
                aria-label=${`Variable ${index + 1} value`}
                type="password"
                autocomplete="off"
                placeholder=${kept(saved.includes(row.name.trim()))}
                class="${INPUT_CLASSES} flex-1"
                @input=${(e: Event) => { if (e.target instanceof HTMLInputElement) this._setEnv(index, { value: e.target.value }); }}
                .value=${row.value}
              />
              <button type="button" class="text-zinc-500 hover:text-red-400 cursor-pointer p-1" @click=${() => this._setEnv(index, null)}><span class="sr-only">Remove variable ${index + 1}</span>${closeIcon("", 12)}</button>
            </div>
          `)}
        </div>
        <button type="button" class="mt-1.5 text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer" @click=${() => this._set("env", [...env, { name: "", value: "" }])}>Add variable</button>
        <p class="mt-1 text-[10px] text-zinc-500">Values are stored encrypted and not shown again.</p>
      </div>
    `;
  }

  /** A stdio server's fields: its command line, environment and directory. */
  private _renderStdioFields(draft: McpServerDraft, saved: readonly string[]) {
    return html`
      ${this._field("Command", "command", { placeholder: "npx" })}
      <label class="block">
        <span class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1">Arguments</span>
        <textarea
          aria-label="Arguments"
          rows="3"
          spellcheck="false"
          placeholder=${"-y\n@modelcontextprotocol/server-everything"}
          class="${INPUT_CLASSES} font-mono resize-y"
          @input=${(e: Event) => { if (e.target instanceof HTMLTextAreaElement) this._set("args", e.target.value); }}
          .value=${draft.args}
        ></textarea>
      </label>
      <p class="-mt-2 text-[10px] text-zinc-500">One per line.</p>
      ${this._renderEnv(draft.env, saved)}
      ${this._field("Working directory", "cwd", { placeholder: "The session's checkout" })}
      <p class="-mt-2 text-[10px] text-zinc-500">Each session that uses it starts its own process, on the session's node and in its checkout, so the command must be installed on the nodes your sessions use. A relative directory is inside the checkout.</p>
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
        width="lg"
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
            <div>${this._radioGroup("Runs", SERVER_KINDS, draft.transport === "stdio" ? "stdio" : "remote", kind => this._setKind(kind))}</div>
            ${draft.transport === "stdio" ? this._renderStdioFields(draft, existing?.transport === "stdio" ? existing.envNames : []) : html`
            ${this._field("URL", "url", { placeholder: "https://example.com/mcp", type: "url" })}
            <div>
              ${this._radioGroup("Authentication", AUTH_KINDS, draft.authKind, kind => this._set("authKind", kind))}
              <p class="mt-1 text-[10px] text-zinc-500">${AUTH_KINDS.find(option => option.kind === draft.authKind)?.hint}</p>
            </div>
            ${draft.authKind === "header" ? html`
              ${this._field("Header name", "headerName", { placeholder: "Authorization" })}
              ${this._field("Header value", "headerValue", { type: "password", placeholder: kept(existing?.transport !== "stdio" && existing?.hasHeaderValue) })}
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
                ${this._field("Client secret", "oauthClientSecret", { type: "password", placeholder: kept(existing?.transport !== "stdio" && existing?.hasClientSecret) })}
                ${this._field("Scope", "oauthScope", { placeholder: "The server's own when blank" })}
              ` : nothing}
            ` : nothing}
            `}
          </div>
        ` : nothing}
        .actions=${html`
          ${dialogButton({ label: "Cancel", onClick: this._closeForm })}
          ${dialogButton({ label: saving ? "Saving..." : "Save", variant: "primary", type: "submit", disabled: saving || !draft?.name.trim() || !(draft?.transport === "stdio" ? draft.command : draft?.url)?.trim() })}
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
        <p class="text-xs text-zinc-500">A project can also define servers in a <span class="font-mono">.mcp.json</span> in its repository. Type <span class="font-mono">/mcp</span> in a session to see them, with yours.</p>
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
