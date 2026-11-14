/**
 * The servers of a `.mcp.json` (`<mcp-repo-servers>`), read-only, each with its kind, its command or URL, its status
 * and its toggle: whether it may run, for the project. Turning a stdio server on allows its exact command for the
 * project; a command changed since shows off until turned on again. It is the first section of a session's list (the
 * Inspector's `mcp-servers` view: the session's own checkout's file), before the user's own servers. Also Sign in or
 * Sign out, the tools, the values of the variables and the entries skipped, with why. Its actions take effect at once.
 * It is kept current from the extension's `mcp_repo_changed` messages and loaded again on reconnect. A session of no
 * project has no section.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Disposer, ReinsSdk } from "@reins/sdk";
import type { McpApi } from "@backend/extensions/mcp/api.js";
import type { McpSessionServersView, McpRepoServerView } from "@backend/extensions/mcp/repo-servers.js";
import type { McpTool } from "@backend/extensions/mcp/connections.js";
import { Loadable } from "../../helpers/loadable.js";
import { showToast } from "../../ui/toast.js";
import { commandLine } from "./mcp-servers-store.js";
import { ClampedTexts, ROW_BUTTON, SECTION_HEADING, mcpServerCard, openSignInWindow, showSignInPage } from "./server-card.js";

type McpSdk = Pick<ReinsSdk<McpApi>, "http" | "onMessage" | "onReconnect" | "projects">;

const PLAIN_BUTTON = `${ROW_BUTTON} border-zinc-600 text-zinc-300 hover:bg-zinc-700`;
const INPUT = "min-w-0 flex-1 px-2 py-1 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** What the section says of its file, when its servers do not say it. */
function fileLine(view: McpSessionServersView): string | null {
  const { file } = view;
  if (!file) return "Read when this session next starts.";
  if (file.state === "missing") return "No .mcp.json in this checkout.";
  if (file.state === "invalid") return `This .mcp.json could not be used: ${file.error}`;
  return view.servers.length === 0 && view.skipped.length === 0 ? "This .mcp.json has no servers." : null;
}

@customElement("mcp-repo-servers")
export class McpRepoServers extends LitElement {
  @property({ attribute: false }) reins: McpSdk | null = null;
  /** The Inspector's list: the servers of this session's own checkout. */
  @property({ attribute: false }) sessionId: string | null = null;

  /** Undefined until loaded; null for a session of no project. */
  @state() private view: McpSessionServersView | null | undefined = undefined;
  @state() private error = "";
  /** What is in progress, by server ID (or `<id>:<hash>` for a version). */
  @state() private busy = new Set<string>();
  @state() private tools = new Map<number, Loadable<McpTool[]>>();
  /** The sign-in started here, until the server says it is signed in or the user cancels: its page, as a link too,
   * as a browser may open no window (a blocked popup, an installed app). */
  @state() private signingIn: { serverId: number; authorizationUrl: string } | null = null;
  /** The values typed for each server's variables, by `<id>:<name>`; sent only when saved. */
  @state() private values = new Map<string, string>();

  private readonly clamped = new ClampedTexts(this);
  private stops: Disposer[] = [];
  private latest = 0;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    const reins = this.reins;
    if (!reins) return;
    this.stops = [
      reins.onMessage(message => {
        if ("type" in message && message.type === "mcp_repo_changed" && "projectId" in message && message.projectId === this.shownProject()) void this.load();
      }),
      reins.onReconnect(() => void this.load()),
    ];
    void this.load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    for (const stop of this.stops.splice(0)) stop();
    this.values = new Map();
  }

  /** The project whose changes it follows: the session's, once loaded (any until then). */
  private shownProject(): number | null | undefined {
    return this.view?.projectId;
  }

  async load(): Promise<void> {
    const reins = this.reins;
    const sessionId = this.sessionId;
    if (!reins || sessionId === null) return;
    const asked = ++this.latest;
    try {
      const view = await reins.http.call("sessionServers", { sessionId });
      if (asked !== this.latest) return;
      this.view = view;
      const signingIn = this.signingIn && view?.servers.find(server => server.id === this.signingIn?.serverId);
      if (signingIn && signingIn.transport !== "stdio" && signingIn.signedIn) this.signingIn = null;
      this.error = "";
    } catch (error) {
      if (asked === this.latest) this.error = errorMessage(error);
    }
  }

  private async act(key: string, label: string, work: (reins: McpSdk) => Promise<unknown>) {
    const reins = this.reins;
    if (!reins || this.busy.has(key)) return;
    this.busy = new Set([...this.busy, key]);
    try {
      await work(reins);
      await this.load();
    } catch (error) {
      showToast(`${label}: ${errorMessage(error)}`, "error");
    } finally {
      const busy = new Set(this.busy);
      busy.delete(key);
      this.busy = busy;
    }
  }

  private async signIn(server: McpRepoServerView) {
    const popup = openSignInWindow();
    const reins = this.reins;
    if (!reins) return;
    try {
      const { authorizationUrl } = await reins.http.call("signIn", { id: server.id });
      this.signingIn = { serverId: server.id, authorizationUrl };
      showSignInPage(popup, authorizationUrl);
    } catch (error) {
      popup?.close();
      showToast(`Failed to start signing in to ${server.name}: ${errorMessage(error)}`, "error");
    }
  }

  private async toggleTools(server: McpRepoServerView) {
    const reins = this.reins;
    const sessionId = this.sessionId;
    const tools = new Map(this.tools);
    if (tools.delete(server.id) || !reins || sessionId === null) {
      this.tools = tools;
      return;
    }
    const loading = Loadable.idle<McpTool[]>().asLoading();
    this.tools = tools.set(server.id, loading);
    const listed = await reins.http.call("tools", { id: server.id, sessionId }).then(
      found => loading.asLoaded(found),
      (error: unknown) => loading.asError(errorMessage(error)),
    );
    // Hidden while it listed: it stays hidden.
    if (this.tools.get(server.id) === loading) this.tools = new Map(this.tools).set(server.id, listed);
  }

  private saveVariable(server: McpRepoServerView, name: string, value: string | null) {
    const key = `${server.id}:${name}`;
    return this.act(key, `Failed to save ${name}`, async reins => {
      await reins.http.call("setVariables", { id: server.id, values: { [name]: value } });
      const values = new Map(this.values);
      values.delete(key);
      this.values = values;
    });
  }

  override render() {
    const view = this.view;
    const sessionId = this.sessionId;
    if (view === null) return nothing;
    const line = view && fileLine(view);
    return html`
      <section class="space-y-2 text-xs" aria-label="This project's MCP servers">
        <h3 class=${SECTION_HEADING} translate="no">${view ? this.projectName(view.projectId) : "Project"}</h3>
        ${this.error && !view ? html`<p class="text-red-300">Can't load this project's MCP servers: ${this.error}</p>` : nothing}
        ${view === undefined && !this.error ? html`<p class="text-zinc-500">Loading…</p>` : nothing}
        ${line ? html`<p class="text-zinc-500">${line}</p>` : nothing}
        ${view?.servers.length && sessionId !== null ? html`
          <ul class="space-y-2" aria-label="MCP servers from .mcp.json">${view.servers.map(server => this.renderServer(server, sessionId))}</ul>
        ` : nothing}
        ${view?.skipped.length ? html`
          <div>
            <p class="text-zinc-400">Skipped entries</p>
            <ul class="mt-1 space-y-0.5" aria-label="Skipped entries">
              ${view.skipped.map(entry => html`<li class="text-zinc-500"><span class="font-mono text-zinc-300" translate="no">${entry.name}</span>: ${entry.reason}</li>`)}
            </ul>
          </div>
        ` : nothing}
      </section>
    `;
  }

  private projectName(projectId: number): string {
    return this.reins?.projects.list().find(project => project.id === projectId)?.name ?? "Project";
  }

  private renderServer(server: McpRepoServerView, sessionId: string) {
    const stdio = server.transport === "stdio";
    const busy = this.busy.has(String(server.id));
    const status = server.status;
    const running = server.enabled && status.state !== "off";
    return mcpServerCard({
      id: server.id,
      name: server.name,
      transport: server.transport,
      ...(stdio ? {} : { authKind: server.authKind }),
      where: stdio ? commandLine(server.version) : server.url,
      status,
      toggle: {
        on: server.allowed,
        label: `${server.allowed ? "Turn off" : "Turn on"} ${server.name}`,
        busy,
        flip: () => void this.act(String(server.id), `Failed to change ${server.name}`, reins => reins.http.call("allow", { id: server.id, allowed: !server.allowed, sessionId })),
      },
      signIn: !stdio && running && !server.signedIn && status.state === "needs_sign_in" ? { busy, start: () => void this.signIn(server) } : null,
      before: !stdio && server.signedIn
        ? html`<button class=${PLAIN_BUTTON} ?disabled=${busy} @click=${() => void this.act(String(server.id), `Failed to sign out of ${server.name}`, reins => reins.http.call("signOut", { id: server.id }))}>Sign out</button>`
        : nothing,
      signingIn: this.signingIn?.serverId === server.id ? { authorizationUrl: this.signingIn.authorizationUrl, cancel: () => { this.signingIn = null; } } : null,
      tools: { available: running, shown: this.tools.get(server.id), toggle: () => void this.toggleTools(server) },
      details: html`
        ${stdio && server.version.envNames.length ? html`<p class="mt-1 text-xs text-zinc-500">Env: <span class="font-mono">${server.version.envNames.join(", ")}</span></p>` : nothing}
        ${!stdio && server.headerNames.length ? html`<p class="mt-1 text-xs text-zinc-500">Headers: <span class="font-mono">${server.headerNames.join(", ")}</span></p>` : nothing}
        ${stdio && server.enabled && server.changed ? html`<p class="mt-1 text-xs text-zinc-400">Its command changed since you turned it on.</p>` : nothing}
        ${this.renderVariables(server)}
      `,
    }, this.clamped);
  }

  private renderVariables(server: McpRepoServerView) {
    if (server.variables.length === 0) return nothing;
    return html`
      <div class="mt-2 space-y-1">
        <p class="text-zinc-400">Values for its variables (kept encrypted${server.transport === "stdio" ? "; else the node's environment" : ""})</p>
        ${server.variables.map(({ name, set }) => {
          const key = `${server.id}:${name}`;
          const typed = this.values.get(key) ?? "";
          return html`
            <div class="flex items-center gap-1.5">
              <span class="w-36 shrink-0 truncate font-mono text-zinc-300" translate="no">${name}</span>
              <input
                type="password"
                class=${INPUT}
                aria-label=${name}
                autocomplete="off"
                placeholder=${set ? "Saved (type to replace)" : "Not set"}
                .value=${typed}
                @input=${(event: Event) => { if (event.target instanceof HTMLInputElement) this.values = new Map(this.values).set(key, event.target.value); }}
              />
              <button class=${PLAIN_BUTTON} ?disabled=${!typed || this.busy.has(key)} @click=${() => void this.saveVariable(server, name, typed)}>Save</button>
              ${set ? html`<button class=${PLAIN_BUTTON} ?disabled=${this.busy.has(key)} @click=${() => void this.saveVariable(server, name, null)}>Clear</button>` : nothing}
            </div>
          `;
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mcp-repo-servers": McpRepoServers;
  }
}
