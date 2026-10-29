import { Type, type Static } from "@sinclair/typebox";
import { getDb } from "./app-globals.js";
import { decrypt, encrypt } from "./crypto.js";

/** ADR-004. */
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export const McpAuthKindSchema = Type.Union([Type.Literal("oauth"), Type.Literal("header"), Type.Literal("none")]);
export type McpAuthKind = Static<typeof McpAuthKindSchema>;
export type McpTransportKind = "http";
/** What is kept encrypted for a server: the header's value, a pre-registered client's secret, and its
 * OAuth state (`McpOAuthProvider`): the registered client, tokens, a sign-in's PKCE verifier, discovery. */
export type McpSecretKind = "header_value" | "client_secret" | "client_information" | "tokens" | "code_verifier" | "discovery";

/** What the user configures. */
export interface McpServerFields {
  name: string;
  description: string;
  url: string;
  transport: McpTransportKind;
  authKind: McpAuthKind;
  headerName: string | null;
  oauthClientId: string | null;
  oauthScope: string | null;
  enabled: boolean;
}

export interface McpServerRow extends McpServerFields {
  id: number;
  /** The callback URL of its latest sign-in: refreshes present the client registered for it. */
  oauthRedirectUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawRow {
  id: number; name: string; description: string; url: string; transport: McpTransportKind; auth_kind: McpAuthKind;
  header_name: string | null; oauth_client_id: string | null; oauth_scope: string | null; enabled: number;
  oauth_redirect_url: string | null; created_at: string; updated_at: string;
}

const COLUMNS = "id, name, description, url, transport, auth_kind, header_name, oauth_client_id, oauth_scope, enabled, oauth_redirect_url, created_at, updated_at";

function toRow(raw: RawRow): McpServerRow {
  return {
    id: raw.id, name: raw.name, description: raw.description, url: raw.url, transport: raw.transport, authKind: raw.auth_kind,
    headerName: raw.header_name, oauthClientId: raw.oauth_client_id, oauthScope: raw.oauth_scope, enabled: raw.enabled === 1,
    oauthRedirectUrl: raw.oauth_redirect_url, createdAt: raw.created_at, updatedAt: raw.updated_at,
  };
}

/** In name order. */
export function listMcpServers(): McpServerRow[] {
  return getDb().query<RawRow, []>(`SELECT ${COLUMNS} FROM mcp_servers ORDER BY name`).all().map(toRow);
}

export function getMcpServer(id: number): McpServerRow | null {
  const raw = getDb().query<RawRow, [number]>(`SELECT ${COLUMNS} FROM mcp_servers WHERE id = ?`).get(id);
  return raw ? toRow(raw) : null;
}

export function getMcpServerByName(name: string): McpServerRow | null {
  const raw = getDb().query<RawRow, [string]>(`SELECT ${COLUMNS} FROM mcp_servers WHERE name = ?`).get(name);
  return raw ? toRow(raw) : null;
}

type FieldValues = [string, string, string, McpTransportKind, McpAuthKind, string | null, string | null, string | null, number];
function fieldValues(fields: McpServerFields): FieldValues {
  return [fields.name, fields.description, fields.url, fields.transport, fields.authKind, fields.headerName, fields.oauthClientId, fields.oauthScope, fields.enabled ? 1 : 0];
}

/** Throws a UNIQUE constraint error when the name is taken. */
export function insertMcpServer(fields: McpServerFields): McpServerRow {
  return toRow(getDb().query<RawRow, FieldValues>(
    `INSERT INTO mcp_servers (name, description, url, transport, auth_kind, header_name, oauth_client_id, oauth_scope, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW}, ${NOW}) RETURNING ${COLUMNS}`,
  ).get(...fieldValues(fields))!);
}

/** Throws a UNIQUE constraint error when the name is taken by another server. */
export function updateMcpServer(id: number, fields: McpServerFields): McpServerRow | null {
  const raw = getDb().query<RawRow, [...FieldValues, number]>(
    `UPDATE mcp_servers SET name = ?, description = ?, url = ?, transport = ?, auth_kind = ?, header_name = ?,
       oauth_client_id = ?, oauth_scope = ?, enabled = ?, updated_at = ${NOW}
     WHERE id = ? RETURNING ${COLUMNS}`,
  ).get(...fieldValues(fields), id);
  return raw ? toRow(raw) : null;
}

/** Its secrets go with it. */
export function deleteMcpServer(id: number): boolean {
  return getDb().query("DELETE FROM mcp_servers WHERE id = ?").run(id).changes > 0;
}

export function getMcpSecret(id: number, kind: McpSecretKind): string | null {
  const row = getDb().query<{ value: string }, [number, string]>("SELECT value FROM mcp_server_secrets WHERE server_id = ? AND kind = ?").get(id, kind);
  return row ? decrypt(row.value) : null;
}

/** Stores the secret encrypted; null deletes it. */
export function setMcpSecret(id: number, kind: McpSecretKind, value: string | null): void {
  if (value === null) {
    getDb().query("DELETE FROM mcp_server_secrets WHERE server_id = ? AND kind = ?").run(id, kind);
    return;
  }
  getDb().query(
    `INSERT INTO mcp_server_secrets (server_id, kind, value, updated_at) VALUES (?, ?, ?, ${NOW})
     ON CONFLICT(server_id, kind) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(id, kind, encrypt(value));
}

/** The kinds of secret the server has, none of their values. */
export function mcpSecretKinds(id: number): Set<McpSecretKind> {
  return new Set(getDb().query<{ kind: McpSecretKind }, [number]>("SELECT kind FROM mcp_server_secrets WHERE server_id = ?").all(id).map(row => row.kind));
}

export function deleteMcpSecrets(id: number, kinds: readonly McpSecretKind[]): void {
  for (const kind of kinds) setMcpSecret(id, kind, null);
}

/** Records a sign-in in progress, replacing any earlier one of the server: the hash of its `state`, the
 * callback URL it was started for and its PKCE verifier (`code_verifier`). */
export function beginMcpSignIn(id: number, stateHash: string, redirectUrl: string): void {
  getDb().query(
    `UPDATE mcp_servers SET sign_in_state_hash = ?, sign_in_started_at = ${NOW}, oauth_redirect_url = ? WHERE id = ?`,
  ).run(stateHash, redirectUrl, id);
}

/** The callback URL of the server's latest sign-in, else of the latest any server was started for. */
export function latestMcpRedirectUrl(id: number): string | null {
  return getDb().query<{ url: string }, [number]>(
    `SELECT oauth_redirect_url AS url FROM mcp_servers WHERE oauth_redirect_url IS NOT NULL
     ORDER BY id = ? DESC, sign_in_started_at IS NULL, sign_in_started_at DESC, updated_at DESC LIMIT 1`,
  ).get(id)?.url ?? null;
}

/** The server whose sign-in in progress has this state hash, and how many seconds ago it started. */
export function findMcpSignIn(stateHash: string): { serverId: number; ageSeconds: number } | null {
  return getDb().query<{ serverId: number; ageSeconds: number }, [string]>(
    `SELECT id AS serverId, CAST(strftime('%s', 'now') - strftime('%s', sign_in_started_at) AS INTEGER) AS ageSeconds
     FROM mcp_servers WHERE sign_in_state_hash = ?`,
  ).get(stateHash) ?? null;
}

/** The server has no sign-in in progress any more (its verifier goes too). */
export function endMcpSignIn(id: number): void {
  getDb().transaction(() => {
    getDb().query("UPDATE mcp_servers SET sign_in_state_hash = NULL, sign_in_started_at = NULL WHERE id = ?").run(id);
    setMcpSecret(id, "code_verifier", null);
  })();
}
