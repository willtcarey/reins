/**
 * MCP Servers Store
 *
 * Owns the settings page's MCP server list, kept current from `mcp_server_updated` and
 * `mcp_server_removed`; adding, changing and removing servers; OAuth sign-in (started here, completed in
 * the window the section opens, announced by the server's message); and the tool lists of the servers
 * whose tools are shown, listed again when a server's tools change. Secrets are only ever written: a server
 * says whether it has them.
 */

import type { McpServerInput, McpServerUpdate, McpServerView } from "@backend/models/mcp-servers.js";
import type { McpServerStatus, McpTool } from "@backend/mcp/connections.js";
import { api } from "../api.js";
import { Loadable } from "../../helpers/loadable.js";
import type { InboundEventSource } from "../ws-client.js";

export type McpServersStoreResult = { ok: true } | { error: string };
export type McpAuthKind = McpServerView["authKind"];

/** The add/edit form's fields. A secret left blank is kept as it is (none for a new server). */
export interface McpServerDraft {
  name: string;
  description: string;
  url: string;
  authKind: McpAuthKind;
  headerName: string;
  headerValue: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
}

export function emptyDraft(): McpServerDraft {
  return { name: "", description: "", url: "", authKind: "oauth", headerName: "", headerValue: "", oauthClientId: "", oauthClientSecret: "", oauthScope: "" };
}

/** The form filled from a server, its secrets blank. */
export function draftOf(server: McpServerView): McpServerDraft {
  return {
    name: server.name,
    description: server.description,
    url: server.url,
    authKind: server.authKind,
    headerName: server.headerName ?? "",
    headerValue: "",
    oauthClientId: server.oauthClientId ?? "",
    oauthClientSecret: "",
    oauthScope: server.oauthScope ?? "",
  };
}

function optional(value: string): string | null {
  return value.trim() || null;
}

/** What the form sends: only its auth kind's fields, and a secret only when one was typed. */
export function draftRequest(draft: McpServerDraft): McpServerInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    url: draft.url.trim(),
    authKind: draft.authKind,
    ...(draft.authKind === "header" ? {
      headerName: draft.headerName.trim(),
      ...(draft.headerValue ? { headerValue: draft.headerValue } : {}),
    } : {}),
    ...(draft.authKind === "oauth" ? {
      oauthClientId: optional(draft.oauthClientId),
      oauthScope: optional(draft.oauthScope),
      ...(draft.oauthClientSecret ? { oauthClientSecret: draft.oauthClientSecret } : {}),
    } : {}),
  };
}

/** What the user can do about a server's status: sign in when it needs to, else connect (again). */
export function primaryAction(server: McpServerView): "sign-in" | "connect" | null {
  if (!server.enabled) return null;
  if (server.status.state === "needs_sign_in") return server.authKind === "oauth" ? "sign-in" : null;
  return server.status.state === "connected" || server.status.state === "connecting" ? null : "connect";
}

const STATUS_LABELS: Record<McpServerStatus["state"], string> = {
  connected: "connected",
  connecting: "connecting…",
  not_connected: "not connected",
  needs_sign_in: "needs sign-in",
  error: "error",
  disabled: "disabled",
};

export function statusLabel(status: McpServerStatus): string {
  return STATUS_LABELS[status.state];
}

export type McpServerAction = "saving" | "testing" | "signing-in" | "signing-out" | "removing";

const byName = (a: McpServerView, b: McpServerView) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export class McpServersStore {
  servers: Loadable<McpServerView[]> = Loadable.idle();
  /** The tools of each server whose tools are shown. */
  tools = new Map<number, Loadable<McpTool[]>>();
  /** What is in progress for each server. */
  actions = new Map<number, McpServerAction>();
  /** The sign-in waiting for its window: until the server says it is signed in, or another starts. */
  signIn: { serverId: number; authorizationUrl: string } | null = null;
  creating = false;

  private _listeners = new Set<() => void>();
  private _unsubscribe: (() => void) | null = null;

  constructor(eventSource?: InboundEventSource) {
    this._unsubscribe = eventSource?.subscribe({
      mcp_server_updated: (message) => {
        const previous = this.servers.data?.find(server => server.id === message.server.id);
        this._upsert(message.server);
        if (this.signIn?.serverId === message.server.id && message.server.signedIn) this.signIn = null;
        if (this.tools.has(message.server.id) && previous && previous.toolCount !== message.server.toolCount && message.server.status.state === "connected") {
          void this.loadTools(message.server.id);
        }
        this.notify();
      },
      mcp_server_removed: (message) => {
        this._drop(message.serverId);
        this.notify();
      },
    }) ?? null;
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  dispose() {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  async load(): Promise<McpServersStoreResult> {
    this.servers = this.servers.asLoading();
    this.notify();
    try {
      this.servers = this.servers.asLoaded(await api.mcpServers.list());
      return { ok: true };
    } catch (err: unknown) {
      const error = errorMessage(err);
      this.servers = this.servers.asError(error);
      return { error };
    } finally {
      this.notify();
    }
  }

  async create(draft: McpServerDraft): Promise<McpServersStoreResult> {
    this.creating = true;
    this.notify();
    try {
      this._upsert(await api.mcpServers.create(draftRequest(draft)));
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.creating = false;
      this.notify();
    }
  }

  update(serverId: number, draft: McpServerDraft): Promise<McpServersStoreResult> {
    return this._act(serverId, "saving", async () => this._upsert(await api.mcpServers.update(serverId, draftRequest(draft))));
  }

  setEnabled(serverId: number, enabled: boolean): Promise<McpServersStoreResult> {
    return this._act(serverId, "saving", async () => this._upsert(await api.mcpServers.update(serverId, { enabled } satisfies McpServerUpdate)));
  }

  /** Connects afresh; the server's status says how it went. */
  test(serverId: number): Promise<McpServersStoreResult> {
    return this._act(serverId, "testing", async () => this._upsert(await api.mcpServers.test(serverId)));
  }

  /** Starts a sign-in: the authorization URL, for the window the section opened. */
  async startSignIn(serverId: number): Promise<{ authorizationUrl: string } | { error: string }> {
    let started: { authorizationUrl: string } | null = null;
    const result = await this._act(serverId, "signing-in", async () => {
      started = await api.mcpServers.signIn(serverId);
      this.signIn = { serverId, authorizationUrl: started.authorizationUrl };
    });
    return "error" in result ? result : started!;
  }

  cancelSignIn() {
    if (!this.signIn) return;
    this.signIn = null;
    this.notify();
  }

  signOut(serverId: number): Promise<McpServersStoreResult> {
    return this._act(serverId, "signing-out", async () => this._upsert(await api.mcpServers.signOut(serverId)));
  }

  remove(serverId: number): Promise<McpServersStoreResult> {
    return this._act(serverId, "removing", async () => {
      await api.mcpServers.remove(serverId);
      this._drop(serverId);
    });
  }

  /** Shows the server's tools, listing them, or hides them. */
  toggleTools(serverId: number) {
    if (this.tools.delete(serverId)) {
      this.notify();
      return;
    }
    void this.loadTools(serverId);
  }

  async loadTools(serverId: number): Promise<McpServersStoreResult> {
    this.tools.set(serverId, (this.tools.get(serverId) ?? Loadable.idle<McpTool[]>()).asLoading());
    this.notify();
    try {
      const tools = await api.mcpServers.tools(serverId);
      if (this.tools.has(serverId)) this.tools.set(serverId, this.tools.get(serverId)!.asLoaded(tools));
      return { ok: true };
    } catch (err: unknown) {
      const error = errorMessage(err);
      if (this.tools.has(serverId)) this.tools.set(serverId, this.tools.get(serverId)!.asError(error));
      return { error };
    } finally {
      this.notify();
    }
  }

  private async _act(serverId: number, action: McpServerAction, work: () => Promise<void>): Promise<McpServersStoreResult> {
    this.actions.set(serverId, action);
    this.notify();
    try {
      await work();
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.actions.delete(serverId);
      this.notify();
    }
  }

  /** Nothing is listed before the first load. */
  private _upsert(server: McpServerView) {
    const servers = this.servers.data;
    if (!servers) return;
    this.servers = this.servers.asLoaded([...servers.filter(s => s.id !== server.id), server].toSorted(byName));
  }

  private _drop(serverId: number) {
    const servers = this.servers.data;
    if (servers) this.servers = this.servers.asLoaded(servers.filter(server => server.id !== serverId));
    this.tools.delete(serverId);
    if (this.signIn?.serverId === serverId) this.signIn = null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
