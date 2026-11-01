import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";

const TABLES = ["mcp_servers", "mcp_server_secrets"] as const;

/**
 * Migration 060: the MCP extension's tables leave the main database for the extension's own
 * (`<data dir>/extensions/mcp/db.sqlite`, ADR-032). It runs before any extension registers, so it makes the
 * tables there itself from the main database's definitions (those of MCP's first migration, which then finds
 * them made), and copies the rows as they are: secrets stay sealed with the server's key. A row the
 * extension's database has already is kept. Best effort: a failed copy is logged, and the tables are
 * dropped all the same. A database with no file (in memory) has nowhere to copy to.
 */
export function moveMcpServersToExtension(db: Database): void {
  const hasServers = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_servers'").get() !== null
    && db.query("SELECT 1 FROM mcp_servers LIMIT 1").get() !== null;
  if (hasServers && db.filename && db.filename !== ":memory:") {
    try {
      copy(db, join(dirname(db.filename), "extensions", "mcp", "db.sqlite"));
    } catch (error) {
      logger.warn("Copying the MCP servers to the MCP extension's database failed; they are dropped:", error);
    }
  }
  db.exec("DROP TABLE IF EXISTS mcp_server_secrets; DROP TABLE IF EXISTS mcp_servers;");
}

function copy(db: Database, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  db.query("ATTACH DATABASE ? AS mcp_extension").run(path);
  try {
    db.exec("PRAGMA mcp_extension.journal_mode = WAL");
    db.transaction(() => {
      for (const table of TABLES) {
        const { sql } = db.query<{ sql: string }, [string]>("SELECT sql FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(table)!;
        db.exec(sql.replace(/^CREATE TABLE\s+"?\w+"?/, `CREATE TABLE IF NOT EXISTS mcp_extension.${table}`));
        const columns = db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}', 'main')`).all().map(column => column.name).join(", ");
        // A secret of a server left out (its name taken there by another) would break its foreign key.
        const kept = table === "mcp_server_secrets" ? " WHERE server_id IN (SELECT id FROM mcp_extension.mcp_servers)" : "";
        const copied = db.query(`INSERT OR IGNORE INTO mcp_extension.${table} (${columns}) SELECT ${columns} FROM main.${table}${kept}`).run().changes;
        logger.info(`  Copied ${copied} row(s) of ${table} to the MCP extension's database`);
      }
    })();
  } finally {
    db.exec("DETACH DATABASE mcp_extension");
  }
}
