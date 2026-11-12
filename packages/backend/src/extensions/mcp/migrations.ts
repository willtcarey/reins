/** The MCP extension's database (`reins.db`): its migrations, which the host applies before it registers. */

import type { Migration } from "@reins/sdk/server";

export const mcpMigrations: readonly Migration[] = [
  {
    // IF NOT EXISTS: the core's migration 060 may have made them already, with the servers the main
    // database had (ADR-032).
    id: "001_servers",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        instructions TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        transport TEXT NOT NULL DEFAULT 'http',
        auth_kind TEXT NOT NULL CHECK (auth_kind IN ('oauth', 'header', 'none')),
        header_name TEXT,
        oauth_client_id TEXT,
        oauth_scope TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        oauth_redirect_url TEXT,
        sign_in_state_hash TEXT UNIQUE,
        sign_in_started_at TEXT,
        sign_in_redirect_url TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS mcp_server_secrets (
        server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (server_id, kind)
      );
    `),
  },
  {
    // Its secrets are in the host's secret storage now (`reins.secrets`, ADR-033). Those already stored are
    // not moved: no instance but the one that moved them by hand had any.
    id: "002_host_secrets",
    up: db => db.exec(`
      ALTER TABLE mcp_servers ADD COLUMN oauth_tokens_issued_at TEXT;
      DROP TABLE mcp_server_secrets;
    `),
  },
  {
    // Stdio servers: a command run for each calling session, in its checkout, its environment a secret (`env`). Their
    // tool lists are kept, by the node they ran on, so a search answers while no process runs.
    id: "003_stdio",
    up: db => db.exec(`
      ALTER TABLE mcp_servers ADD COLUMN command TEXT;
      ALTER TABLE mcp_servers ADD COLUMN args TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE mcp_servers ADD COLUMN cwd TEXT;
      CREATE TABLE mcp_tool_lists (
        server_id INTEGER NOT NULL,
        node_id TEXT NOT NULL,
        tools TEXT NOT NULL,
        listed_at TEXT NOT NULL,
        PRIMARY KEY (server_id, node_id)
      );
    `),
  },
];
