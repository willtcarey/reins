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
  {
    // Repo servers (a project's `.mcp.json`): a row for each project and name (`project_id`; null for the user's own),
    // with the entry as last read (`repo_json`), so a name is unique within a project or among the user's own. The
    // table is rebuilt to drop `name UNIQUE`, keeping the ID sequence: IDs are never used again. What each session
    // read is `mcp_repo_reads` (allowed commands are secrets: `repo-gate.ts`).
    id: "004_repo_servers",
    up: db => {
      const sequence = db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'mcp_servers'").get()?.seq ?? 0;
      db.exec(`
        CREATE TABLE mcp_servers_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER,
          name TEXT NOT NULL,
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
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          oauth_tokens_issued_at TEXT,
          command TEXT,
          args TEXT NOT NULL DEFAULT '[]',
          cwd TEXT,
          repo_json TEXT
        );
        INSERT INTO mcp_servers_new (id, name, instructions, url, transport, auth_kind, header_name, oauth_client_id, oauth_scope, enabled,
          oauth_redirect_url, sign_in_state_hash, sign_in_started_at, sign_in_redirect_url, created_at, updated_at, oauth_tokens_issued_at, command, args, cwd)
        SELECT id, name, instructions, url, transport, auth_kind, header_name, oauth_client_id, oauth_scope, enabled,
          oauth_redirect_url, sign_in_state_hash, sign_in_started_at, sign_in_redirect_url, created_at, updated_at, oauth_tokens_issued_at, command, args, cwd
        FROM mcp_servers;
        DROP TABLE mcp_servers;
        ALTER TABLE mcp_servers_new RENAME TO mcp_servers;
        CREATE UNIQUE INDEX mcp_servers_project_name ON mcp_servers (IFNULL(project_id, 0), name);
        CREATE TABLE mcp_repo_reads (
          session_id TEXT PRIMARY KEY,
          project_id INTEGER NOT NULL,
          file_json TEXT NOT NULL,
          read_at TEXT NOT NULL
        );
        CREATE INDEX mcp_repo_reads_project ON mcp_repo_reads (project_id, read_at);
      `);
      db.query("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'mcp_servers'").run(sequence);
      if (sequence > 0 && !db.query("SELECT 1 FROM sqlite_sequence WHERE name = 'mcp_servers'").get()) {
        db.query("INSERT INTO sqlite_sequence (name, seq) VALUES ('mcp_servers', ?)").run(sequence);
      }
    },
  },
];
