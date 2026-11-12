/**
 * MCP Servers Store
 *
 * Owns the Settings page's MCP server list, kept current from the extension's messages
 * (`mcp_server_updated`, `mcp_server_removed`) and listed again when the connection comes back; adding, changing and removing servers; OAuth sign-in (started here, completed in
 * the window the section opens, announced by the server's message); and the tool lists of the servers
 * whose tools are shown, listed when shown. Secrets are only ever written: a server says whether it has them.
 */

import type { McpApi } from "@backend/extensions/mcp/api.js";
import type { McpMessage, McpRemoteServerView, McpServerView, McpStdioServerView } from "@backend/extensions/mcp/servers.js";
import type { McpServerInput } from "@backend/extensions/mcp/input.js";
import type { McpServerStatus, McpTool } from "@backend/extensions/mcp/connections.js";
import type { Http, ReinsSdk } from "@reins/sdk";
import { Loadable } from "../../helpers/loadable.js";

/** Which of the extension's messages it is (its backend part sends them; it is trusted for their shape). */
function isMcpMessage(message: object): message is McpMessage {
  return "type" in message && (message.type === "mcp_server_updated" || message.type === "mcp_server_removed");
}

export type McpServersStoreResult = { ok: true } | { error: string };
export type McpAuthKind = McpRemoteServerView["authKind"];
export type McpTransportKind = McpServerView["transport"];

/** A stdio server's environment variable in the form: its value blank keeps the stored one. */
export interface McpEnvDraft { name: string; value: string }

/** The add/edit form's fields. A secret left blank is kept as it is (none for a new server). `args`: one per line. */
export interface McpServerDraft {
  name: string;
  instructions: string;
  url: string;
  transport: McpTransportKind;
  authKind: McpAuthKind;
  headerName: string;
  headerValue: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  command: string;
  args: string;
  cwd: string;
  env: McpEnvDraft[];
}

export function emptyDraft(): McpServerDraft {
  return {
    name: "", instructions: "", url: "", transport: "http", authKind: "oauth", headerName: "", headerValue: "", oauthClientId: "", oauthClientSecret: "", oauthScope: "",
    command: "", args: "", cwd: "", env: [],
  };
}

/** The form filled from a server, its secrets blank, the other kind's fields empty. */
export function draftOf(server: McpServerView): McpServerDraft {
  const draft = { ...emptyDraft(), name: server.name, instructions: server.instructions, transport: server.transport };
  if (server.transport === "stdio") {
    return { ...draft, command: server.command, args: server.args.join("\n"), cwd: server.cwd ?? "", env: server.envNames.map(name => ({ name, value: "" })) };
  }
  return {
    ...draft,
    url: server.url,
    authKind: server.authKind,
    headerName: server.headerName ?? "",
    oauthClientId: server.oauthClientId ?? "",
    oauthScope: server.oauthScope ?? "",
  };
}

function optional(value: string): string | null {
  return value.trim() || null;
}

/** What the form sends: only its transport's and auth kind's fields, and a secret only when one was typed (a stdio
 * server's variable left blank is sent as null, which keeps its stored value). */
export function draftRequest(draft: McpServerDraft): McpServerInput {
  if (draft.transport === "stdio") {
    return {
      name: draft.name.trim(),
      instructions: draft.instructions.trim(),
      transport: "stdio",
      command: draft.command.trim(),
      args: draft.args.split("\n").filter(arg => arg.trim()),
      cwd: optional(draft.cwd),
      env: Object.fromEntries(draft.env.filter(row => row.name.trim()).map(row => [row.name.trim(), row.value || null])),
    };
  }
  return {
    name: draft.name.trim(),
    instructions: draft.instructions.trim(),
    url: draft.url.trim(),
    transport: draft.transport,
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

/** Whether the server is waiting for the user to sign in: the one status that only the user can fix. */
export function needsSignIn(server: McpServerView): boolean {
  return server.enabled && server.transport !== "stdio" && server.authKind === "oauth" && server.status.state === "needs_sign_in";
}

/** Whether testing it could tell something: agents connect anyway when they use it, so this is for checking
 * it again, after a failure or a change at the server. Not a stdio server: it runs in a session, and Settings has
 * none. */
export function mayTest(server: McpServerView): boolean {
  return server.enabled && server.transport !== "stdio" && server.status.state !== "needs_sign_in";
}

/** The command line of a stdio server, as a user would type it. */
export function commandLine(server: McpStdioServerView): string {
  return [server.command, ...server.args.map(arg => /[\s"']/.test(arg) ? JSON.stringify(arg) : arg)].join(" ");
}

const STATUS_LABELS: Record<McpServerStatus["state"], string> = {
  ready: "ready",
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
  private _unsubscribe: Array<() => void>;
  private readonly _http: Http<McpApi>;

  constructor(reins: Pick<ReinsSdk<McpApi>, "http" | "onMessage" | "onReconnect">) {
    this._http = reins.http;
    this._unsubscribe = [
      reins.onMessage((message) => {
        if (!isMcpMessage(message)) return;
        if (message.type === "mcp_server_updated") {
          this._upsert(message.server);
          if (this.signIn?.serverId === message.server.id && message.server.transport !== "stdio" && message.server.signedIn) this.signIn = null;
        } else {
          this._drop(message.serverId);
        }
        this.notify();
      }),
      reins.onReconnect(() => {
        if (this.servers.status !== "idle") void this.load();
      }),
    ];
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  dispose() {
    for (const unsubscribe of this._unsubscribe.splice(0)) unsubscribe();
  }

  async load(): Promise<McpServersStoreResult> {
    this.servers = this.servers.asLoading();
    this.notify();
    try {
      this.servers = this.servers.asLoaded(await this._http.call("list"));
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
      this._upsert(await this._http.call("create", draftRequest(draft)));
      return { ok: true };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    } finally {
      this.creating = false;
      this.notify();
    }
  }

  update(serverId: number, draft: McpServerDraft): Promise<McpServersStoreResult> {
    return this._act(serverId, "saving", async () => this._upsert(await this._http.call("update", { id: serverId, changes: draftRequest(draft) })));
  }

  setEnabled(serverId: number, enabled: boolean): Promise<McpServersStoreResult> {
    return this._act(serverId, "saving", async () => this._upsert(await this._http.call("update", { id: serverId, changes: { enabled } })));
  }

  /** Connects afresh (a stdio server's process started again); the server's status says how it went. Tools shown
   * are listed again: the server may list others now. */
  test(serverId: number): Promise<McpServersStoreResult> {
    return this._act(serverId, "testing", async () => {
      this._upsert(await this._http.call("test", { id: serverId }));
      if (this.tools.has(serverId)) void this.loadTools(serverId);
    });
  }

  /** Starts a sign-in: the authorization URL, for the window the section opened. */
  async startSignIn(serverId: number): Promise<{ authorizationUrl: string } | { error: string }> {
    let started: { authorizationUrl: string } | null = null;
    const result = await this._act(serverId, "signing-in", async () => {
      started = await this._http.call("signIn", { id: serverId });
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
    return this._act(serverId, "signing-out", async () => this._upsert(await this._http.call("signOut", { id: serverId })));
  }

  remove(serverId: number): Promise<McpServersStoreResult> {
    return this._act(serverId, "removing", async () => {
      await this._http.call("remove", { id: serverId });
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
      const tools = await this._http.call("tools", { id: serverId });
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
