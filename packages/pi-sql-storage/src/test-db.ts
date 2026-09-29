import { Database } from "bun:sqlite";

/** The shared Pi table layout as the node and server migrations create it (each owns its own ledger;
 * extra columns they add are irrelevant here). */
const PI_TABLES = `CREATE TABLE sessions (id TEXT PRIMARY KEY, harness_next_seq INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, parent_id INTEGER REFERENCES session_messages(id) ON DELETE SET NULL,
    harness_id TEXT NOT NULL, role TEXT NOT NULL, message_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(session_id, seq), UNIQUE(session_id, harness_id));
  CREATE TABLE pi_values (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, value_json TEXT NOT NULL,
    PRIMARY KEY(session_id, namespace, key));
  CREATE TABLE pi_lists (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, value_json TEXT NOT NULL,
    PRIMARY KEY(session_id, namespace, key, seq));
  CREATE TABLE pi_usage (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    id TEXT NOT NULL, seq INTEGER NOT NULL, entry_id TEXT, adjustment INTEGER NOT NULL,
    usage_json TEXT NOT NULL, details_json TEXT, PRIMARY KEY(session_id, id), UNIQUE(session_id, seq))`;

/** An in-memory database with the Pi tables and a row for each of `sessionIds`. */
export function piDb(...sessionIds: string[]): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(PI_TABLES);
  for (const id of sessionIds) db.query("INSERT INTO sessions (id) VALUES (?)").run(id);
  return db;
}
