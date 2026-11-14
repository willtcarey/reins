/**
 * The user's own MCP servers in a session's list (`<mcp-own-servers>`, after the project's): each as the Settings page
 * draws it (`mcpServerCard`), with its switch, which acts for every session, Sign in or Sign out, and its tools.
 * Adding, editing and removing are the Settings page's, which its header links to.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ReinsSdk } from "@reins/sdk";
import type { McpServerView } from "@backend/extensions/mcp/servers.js";
import { StoreController } from "../../controllers/store-controller.js";
import { showToast } from "../../ui/toast.js";
import { commandLine, needsSignIn, type McpServersStore, type McpServersStoreResult } from "./mcp-servers-store.js";
import { ClampedTexts, LINK_BUTTON, ROW_BUTTON, SECTION_HEADING, mcpServerCard, openSignInWindow, showSignInPage } from "./server-card.js";

const PLAIN_BUTTON = `${ROW_BUTTON} border-zinc-600 text-zinc-300 hover:bg-zinc-700`;

@customElement("mcp-own-servers")
export class McpOwnServers extends LitElement {
  @property({ attribute: false }) reins: Pick<ReinsSdk, "settings"> | null = null;

  private readonly storeCtrl = new StoreController<McpServersStore>(this);
  private readonly clamped = new ClampedTexts(this);

  @property({ attribute: false })
  set store(store: McpServersStore | null) {
    this.storeCtrl.store = store;
  }

  get store(): McpServersStore | null {
    return this.storeCtrl.store;
  }

  override createRenderRoot() {
    return this;
  }

  private async run(label: string, work: () => Promise<McpServersStoreResult>) {
    const result = await work();
    if ("error" in result) showToast(`${label}: ${result.error}`, "error");
  }

  private async signIn(store: McpServersStore, server: McpServerView) {
    const popup = openSignInWindow();
    const result = await store.startSignIn(server.id);
    if ("error" in result) {
      popup?.close();
      showToast(`Failed to start signing in to ${server.name}: ${result.error}`, "error");
      return;
    }
    showSignInPage(popup, result.authorizationUrl);
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;
    const servers = store.servers;
    return html`
      <section class="space-y-2 text-xs" aria-label="Global MCP servers">
        <div class="flex items-center gap-2">
          <h3 class=${SECTION_HEADING}>Global</h3>
          <button class="ml-auto ${LINK_BUTTON}" @click=${() => this.reins?.settings.show()}>Edit in Settings</button>
        </div>
        ${servers.error && !servers.data ? html`<p class="text-red-300">Can't load your MCP servers: ${servers.error}</p>` : nothing}
        ${!servers.data && !servers.error ? html`<p class="text-zinc-500">Loading…</p>` : nothing}
        ${servers.data?.length === 0 ? html`<p class="text-zinc-500">You have no MCP servers of your own.</p>` : nothing}
        ${servers.data?.length ? html`
          <ul class="space-y-2" aria-label="Global MCP servers">${servers.data.map(server => this.renderServer(store, server))}</ul>
        ` : nothing}
      </section>
    `;
  }

  private renderServer(store: McpServersStore, server: McpServerView) {
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
      toggle: {
        on: server.enabled,
        label: `${server.enabled ? "Turn off" : "Turn on"} ${server.name}`,
        busy,
        flip: () => void this.run(`Failed to change ${server.name}`, () => store.setEnabled(server.id, !server.enabled)),
      },
      signIn: needsSignIn(server) ? { busy, label: action === "signing-in" ? "Starting…" : "Sign in", start: () => void this.signIn(store, server) } : null,
      before: server.transport !== "stdio" && server.signedIn
        ? html`<button class=${PLAIN_BUTTON} ?disabled=${busy} @click=${() => void this.run(`Failed to sign out of ${server.name}`, () => store.signOut(server.id))}>Sign out</button>`
        : nothing,
      signingIn: signIn?.serverId === server.id ? { authorizationUrl: signIn.authorizationUrl, cancel: () => store.cancelSignIn() } : null,
      tools: { available: server.enabled, shown: store.tools.get(server.id), toggle: () => store.toggleTools(server.id) },
    }, this.clamped);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mcp-own-servers": McpOwnServers;
  }
}
