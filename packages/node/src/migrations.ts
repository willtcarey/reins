import type { Database } from "bun:sqlite";

/**
 * Append-only, node-owned migration history. Never edit, remove, reorder or
 * squash a named migration after it reaches master; append the next number.
 * See docs/dev/node-migrations.md. Backend migrations are a separate ledger.
 */
const migrations = [
  ["001_canonical_node_storage", `CREATE TABLE sessions (id TEXT PRIMARY KEY, source_id INTEGER NOT NULL,
      cwd TEXT NOT NULL, created_at TEXT NOT NULL, parent_session_id TEXT,
      harness_next_seq INTEGER NOT NULL DEFAULT 1);
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
      usage_json TEXT NOT NULL, details_json TEXT, PRIMARY KEY(session_id, id), UNIQUE(session_id, seq));
    CREATE TABLE pending_commits (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      start_seq INTEGER NOT NULL, writes_json TEXT NOT NULL, PRIMARY KEY(session_id, start_seq));
    CREATE TABLE admission_receipts (command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      operation TEXT NOT NULL, payload TEXT NOT NULL)`],
  ["002_node_attachments", `CREATE TABLE node_attachments (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL,
      filename TEXT, width INTEGER, height INTEGER, data BLOB NOT NULL,
      PRIMARY KEY(session_id, attachment_id))`],
  // One ordered per-session outbox for durable node→server reports, so run lifecycle reports reach
  // the server after the commits that preceded them. `ready = 0` holds a settlement (and every later
  // report of its session) while the node reads a child's final reply.
  ["003_session_outbox", `CREATE TABLE session_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('committed', 'started', 'settled')),
      start_seq INTEGER, payload TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 1 CHECK(ready IN (0, 1)),
      CHECK((kind = 'committed') = (start_seq IS NOT NULL)));
    CREATE UNIQUE INDEX session_outbox_commit ON session_outbox(session_id, start_seq) WHERE kind = 'committed';
    CREATE INDEX session_outbox_order ON session_outbox(session_id, id);
    INSERT INTO session_outbox(session_id, kind, start_seq, payload)
      SELECT session_id, 'committed', start_seq, writes_json FROM pending_commits ORDER BY session_id, start_seq;
    DROP TABLE pending_commits`],
  // `task_json`: the task snapshot (title, description, branch) from the session's provision, used for
  // the system prompt and branch checkout at every open; NULL is a scratch session.
  ["004_session_task", `ALTER TABLE sessions ADD COLUMN task_json TEXT
      CHECK(task_json IS NULL OR json_valid(task_json))`],
] as const;

/** Runs before binding or opening a runtime. SQL and its ledger record commit together. */
export function runNodeMigrations(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.transaction(() => {
    const hasLedger = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migrations'").get();
    if (!hasLedger) {
      if (db.query("SELECT 1 FROM sqlite_master LIMIT 1").get()) {
        throw new Error("Unversioned nonempty node storage is unsupported; discard it before restarting the node");
      }
      db.exec(`CREATE TABLE migrations (name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    }
    const applied = new Set(db.query<{ name: string }, []>("SELECT name FROM migrations").all().map(row => row.name));
    for (const name of applied) {
      if (!migrations.some(([known]) => known === name)) throw new Error(`Unknown node migration: ${name}`);
    }
    for (const [name, sql] of migrations) {
      if (applied.has(name)) continue;
      db.exec(sql);
      db.query("INSERT INTO migrations(name) VALUES(?)").run(name);
    }
  })();
}
