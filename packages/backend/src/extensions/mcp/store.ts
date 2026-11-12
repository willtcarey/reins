/**
 * The MCP servers' rows (`mcp_servers`, in the extension's own database, made by its migrations: `migrations.ts`)
 * and their secrets, in the host's secret storage (`reins.secrets`) under `servers/<id>/<kind>`
 * (docs/dev/mcp-servers.md *Modules*). A row's write and a secret's are not one transaction: a server's
 * secrets are deleted before its row, so that none is left behind it.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { Database, SecretStorage } from "@reins/sdk/server";

/** ADR-004. */
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export const McpAuthKindSchema = Type.Union([Type.Literal("oauth"), Type.Literal("header"), Type.Literal("none")]);
export type McpAuthKind = Static<typeof McpAuthKindSchema>;
/** How Reins reaches a server: `http`, streamable HTTP (the current MCP transport); `sse`, the legacy HTTP+SSE
 * transport of servers from before it; `stdio`, a command run on the calling session's node. */
export const McpTransportKindSchema = Type.Union([Type.Literal("http"), Type.Literal("sse"), Type.Literal("stdio")]);
export type McpTransportKind = Static<typeof McpTransportKindSchema>;
/** The transports of a remote server, reached at a URL. */
export const McpRemoteTransportSchema = Type.Union([Type.Literal("http"), Type.Literal("sse")]);
export type McpRemoteTransport = Static<typeof McpRemoteTransportSchema>;
/** What is kept encrypted for a server: the header's value, a pre-registered client's secret, its
 * OAuth state (`McpOAuthProvider`: the registered client, tokens, discovery, and a sign-in's PKCE
 * verifier and the client it registered, until it completes), and a stdio server's environment (`env`, a JSON object). */
const MCP_SECRET_KINDS = [
  "header_value", "client_secret", "client_information", "tokens", "discovery", "code_verifier", "sign_in_client_information", "env",
] as const;
export type McpSecretKind = typeof MCP_SECRET_KINDS[number];

/** What the user configures of any server. */
interface McpCommonFields {
  name: string;
  /** Given to agents in their system prompt: what the server is for and how to use it. */
  instructions: string;
  enabled: boolean;
}

/** A remote server: reached at its URL, with its auth kind's fields (the others null). */
export interface McpRemoteFields extends McpCommonFields {
  transport: McpRemoteTransport;
  url: string;
  authKind: McpAuthKind;
  headerName: string | null;
  oauthClientId: string | null;
  oauthScope: string | null;
}

/** A stdio server: a program run for each calling session, in its checkout. Its environment is a secret (`env`). */
export interface McpStdioFields extends McpCommonFields {
  transport: "stdio";
  command: string;
  args: string[];
  /** Where it starts: null, the checkout; relative, inside it; absolute or `~/…`, as it is. */
  cwd: string | null;
}

/** What the user configures: a remote server or a stdio one, told apart by `transport`. */
export type McpServerFields = McpRemoteFields | McpStdioFields;

interface McpRowFields {
  id: number;
  createdAt: string;
  updatedAt: string;
}

export interface McpRemoteRow extends McpRemoteFields, McpRowFields {
  /** The callback URL its signed-in client was registered for, set when a sign-in completes. */
  oauthRedirectUrl: string | null;
}

export interface McpStdioRow extends McpStdioFields, McpRowFields {}

export type McpServerRow = McpRemoteRow | McpStdioRow;

export interface McpSignIn {
  serverId: number;
  /** The callback URL it was started for. */
  redirectUrl: string;
  ageSeconds: number;
}

/** A stdio server's tool list as it last listed it, on the node it ran on. */
export interface McpToolList { nodeId: string; tools: string; listedAt: string }

interface RawRow {
  id: number; name: string; instructions: string; url: string; transport: McpTransportKind; command: string | null; args: string; cwd: string | null; auth_kind: McpAuthKind;
  header_name: string | null; oauth_client_id: string | null; oauth_scope: string | null; enabled: number;
  oauth_redirect_url: string | null; created_at: string; updated_at: string;
}

/** Where a server's secrets are in the secret storage. */
const secretPrefix = (id: number) => `servers/${id}/`;
const secretKey = (id: number, kind: McpSecretKind) => `${secretPrefix(id)}${kind}`;

const COLUMNS = "id, name, instructions, url, transport, command, args, cwd, auth_kind, header_name, oauth_client_id, oauth_scope, enabled, oauth_redirect_url, created_at, updated_at";

// The table is flat: a kind's columns are empty for the other kind (a stdio server's `url` "", its `auth_kind`
// "none"). Only `toRow` and `fieldValues` know it.
function toRow(raw: RawRow): McpServerRow {
  const common = { id: raw.id, name: raw.name, instructions: raw.instructions, enabled: raw.enabled === 1, createdAt: raw.created_at, updatedAt: raw.updated_at };
  if (raw.transport === "stdio") {
    return { ...common, transport: "stdio", command: raw.command ?? "", args: parseArgs(raw.args), cwd: raw.cwd };
  }
  return {
    ...common, transport: raw.transport, url: raw.url, authKind: raw.auth_kind, headerName: raw.header_name,
    oauthClientId: raw.oauth_client_id, oauthScope: raw.oauth_scope, oauthRedirectUrl: raw.oauth_redirect_url,
  };
}

function parseArgs(json: string): string[] {
  const args: string[] = JSON.parse(json);
  return args;
}

type FieldValues = [string, string, string, McpTransportKind, string | null, string, string | null, McpAuthKind, string | null, string | null, string | null, number];
function fieldValues(fields: McpServerFields): FieldValues {
  const enabled = fields.enabled ? 1 : 0;
  if (fields.transport === "stdio") {
    return [fields.name, fields.instructions, "", "stdio", fields.command, JSON.stringify(fields.args), fields.cwd, "none", null, null, null, enabled];
  }
  return [
    fields.name, fields.instructions, fields.url, fields.transport, null, "[]", null,
    fields.authKind, fields.headerName, fields.oauthClientId, fields.oauthScope, enabled,
  ];
}

export class McpStore {
  constructor(private readonly db: Database, private readonly secrets: SecretStorage) {}

  /** In name order. */
  list(): McpServerRow[] {
    return this.db.query<RawRow, []>(`SELECT ${COLUMNS} FROM mcp_servers ORDER BY name`).all().map(toRow);
  }

  get(id: number): McpServerRow | null {
    const raw = this.db.query<RawRow, [number]>(`SELECT ${COLUMNS} FROM mcp_servers WHERE id = ?`).get(id);
    return raw ? toRow(raw) : null;
  }

  getByName(name: string): McpServerRow | null {
    const raw = this.db.query<RawRow, [string]>(`SELECT ${COLUMNS} FROM mcp_servers WHERE name = ?`).get(name);
    return raw ? toRow(raw) : null;
  }

  /** Throws a UNIQUE constraint error when the name is taken. */
  insert(fields: McpServerFields): McpServerRow {
    return toRow(this.db.query<RawRow, FieldValues>(
      `INSERT INTO mcp_servers (name, instructions, url, transport, command, args, cwd, auth_kind, header_name, oauth_client_id, oauth_scope, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW}, ${NOW}) RETURNING ${COLUMNS}`,
    ).get(...fieldValues(fields))!);
  }

  /** Throws a UNIQUE constraint error when the name is taken by another server. */
  update(id: number, fields: McpServerFields): McpServerRow | null {
    const raw = this.db.query<RawRow, [...FieldValues, number]>(
      `UPDATE mcp_servers SET name = ?, instructions = ?, url = ?, transport = ?, command = ?, args = ?, cwd = ?, auth_kind = ?, header_name = ?,
         oauth_client_id = ?, oauth_scope = ?, enabled = ?, updated_at = ${NOW}
       WHERE id = ? RETURNING ${COLUMNS}`,
    ).get(...fieldValues(fields), id);
    return raw ? toRow(raw) : null;
  }

  /** Deletes its secrets, then it: stopped between the two, it stays without them rather than they without it. */
  async delete(id: number): Promise<boolean> {
    for (const key of await this.secrets.keys(secretPrefix(id))) await this.secrets.delete(key);
    this.deleteToolLists(id);
    return this.db.query("DELETE FROM mcp_servers WHERE id = ?").run(id).changes > 0;
  }

  /** A stdio server's tool lists, by the node it listed them on, the latest first. */
  toolLists(id: number): McpToolList[] {
    return this.db.query<McpToolList, [number]>(
      "SELECT node_id AS nodeId, tools, listed_at AS listedAt FROM mcp_tool_lists WHERE server_id = ? ORDER BY listed_at DESC, node_id",
    ).all(id);
  }

  setToolList(id: number, nodeId: string, tools: string): void {
    this.db.query(
      `INSERT INTO mcp_tool_lists (server_id, node_id, tools, listed_at) VALUES (?, ?, ?, ${NOW})
       ON CONFLICT (server_id, node_id) DO UPDATE SET tools = excluded.tools, listed_at = excluded.listed_at`,
    ).run(id, nodeId, tools);
  }

  deleteToolLists(id: number): void {
    this.db.query("DELETE FROM mcp_tool_lists WHERE server_id = ?").run(id);
  }

  async getSecret(id: number, kind: McpSecretKind): Promise<string | null> {
    return (await this.secrets.get(secretKey(id, kind))) ?? null;
  }

  /** Stores the secret; null deletes it. Storing tokens records when they were issued (`getTokens`). */
  async setSecret(id: number, kind: McpSecretKind, value: string | null): Promise<void> {
    if (value === null) return this.secrets.delete(secretKey(id, kind));
    await this.secrets.set(secretKey(id, kind), value);
    if (kind === "tokens") this.db.query(`UPDATE mcp_servers SET oauth_tokens_issued_at = ${NOW} WHERE id = ?`).run(id);
  }

  /** The kinds of secret the server has, none of their values. */
  async secretKinds(id: number): Promise<Set<McpSecretKind>> {
    const keys = new Set(await this.secrets.keys(secretPrefix(id)));
    return new Set(MCP_SECRET_KINDS.filter(kind => keys.has(secretKey(id, kind))));
  }

  /** Its OAuth tokens (JSON) and when they were stored: issued at a sign-in, or by the last refresh. */
  async getTokens(id: number): Promise<{ tokens: string; issuedAt: string } | null> {
    const tokens = await this.getSecret(id, "tokens");
    if (tokens === null) return null;
    const issuedAt = this.db.query<{ at: string | null }, [number]>("SELECT oauth_tokens_issued_at AS at FROM mcp_servers WHERE id = ?").get(id)?.at;
    // Unknown is as old as can be: they are refreshed at the next check.
    return { tokens, issuedAt: issuedAt ?? new Date(0).toISOString() };
  }

  async deleteSecrets(id: number, kinds: readonly McpSecretKind[]): Promise<void> {
    for (const kind of kinds) await this.setSecret(id, kind, null);
  }

  /** Records a sign-in in progress, replacing any earlier one of the server: the hash of its `state` and the
   * callback URL it was started for. Its PKCE verifier and any client it registers are its secrets
   * (`code_verifier`, `sign_in_client_information`). */
  beginSignIn(id: number, stateHash: string, redirectUrl: string): void {
    this.db.query(
      `UPDATE mcp_servers SET sign_in_state_hash = ?, sign_in_started_at = ${NOW}, sign_in_redirect_url = ? WHERE id = ?`,
    ).run(stateHash, redirectUrl, id);
  }

  /** The callback URL the server was last signed in through, else the one any server was. */
  latestRedirectUrl(id: number): string | null {
    return this.db.query<{ url: string }, [number]>(
      `SELECT oauth_redirect_url AS url FROM mcp_servers WHERE oauth_redirect_url IS NOT NULL
       ORDER BY id = ? DESC, updated_at DESC LIMIT 1`,
    ).get(id)?.url ?? null;
  }

  /** The sign-in in progress whose state has this hash. */
  findSignIn(stateHash: string): McpSignIn | null {
    return this.db.query<McpSignIn, [string]>(
      `SELECT id AS serverId, sign_in_redirect_url AS redirectUrl,
         CAST(strftime('%s', 'now') - strftime('%s', sign_in_started_at) AS INTEGER) AS ageSeconds
       FROM mcp_servers WHERE sign_in_state_hash = ?`,
    ).get(stateHash) ?? null;
  }

  /** A sign-in's exchange succeeded: its tokens, and the client and callback URL it used, become the
   * server's. `clientInformation` is null for a pre-registered client, which is configured, not stored. */
  async completeSignIn(id: number, { redirectUrl, tokens, clientInformation }: { redirectUrl: string; tokens: string; clientInformation: string | null }): Promise<void> {
    if (clientInformation !== null) await this.setSecret(id, "client_information", clientInformation);
    await this.setSecret(id, "tokens", tokens);
    this.db.query("UPDATE mcp_servers SET oauth_redirect_url = ? WHERE id = ?").run(redirectUrl, id);
  }

  /** The server has no sign-in in progress any more (its verifier and the client it registered go too). */
  async endSignIn(id: number): Promise<void> {
    this.db.query("UPDATE mcp_servers SET sign_in_state_hash = NULL, sign_in_started_at = NULL, sign_in_redirect_url = NULL WHERE id = ?").run(id);
    await this.deleteSecrets(id, ["code_verifier", "sign_in_client_information"]);
  }
}
