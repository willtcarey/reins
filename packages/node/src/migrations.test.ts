import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindNodeSession, nodeSessionBinding, nodeSessionTask, provisionNodeSession } from "./storage.js";
import { runNodeMigrations } from "./migrations.js";
import { hydrateCachedPrompt } from "./node-attachments.js";

const binding = { sourceId: 7, cwd: "/tmp/node", createdAt: "2026-04-01", parentSessionId: null };
const applied = (db: Database) => db.query<{ name: string }, []>("SELECT name FROM migrations ORDER BY name").all().map(row => row.name);
const ledger = `CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO migrations(name) VALUES ('001_canonical_node_storage');`;

// A v1 node database with its migration record, not a legacy unversioned database.
const versionOne = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY, source_id INTEGER NOT NULL,
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
    operation TEXT NOT NULL, payload TEXT NOT NULL);`;

test("fresh node storage initializes bindings, task snapshots, canonical state and attachments, without admission receipts", () => {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  expect(applied(db)).toEqual(["001_canonical_node_storage", "002_node_attachments", "003_session_outbox", "004_session_task", "005_attachment_uploads", "006_node_attachment_content", "007_drop_admission_receipts"]);
  const task = { title: "T", description: null, branchName: "task/t" };
  provisionNodeSession(db, "t", binding, task);
  expect(nodeSessionTask(db, "t")).toEqual(task);
  expect(() => db.query("UPDATE sessions SET task_json = 'not json' WHERE id = 't'").run()).toThrow();
  bindNodeSession(db, "s", binding);
  db.query("UPDATE sessions SET harness_next_seq=3 WHERE id='s'").run();
  db.query(`INSERT INTO session_messages(session_id,seq,harness_id,role,message_json,created_at)
    VALUES ('s',1,'root','user','{"type":"message"}','2026-04-01')`).run();
  db.query(`INSERT INTO pi_values VALUES ('s','lane','head',2,'"root"')`).run();
  db.query(`INSERT INTO pi_lists VALUES ('s','inbox','items',2,'{"id":1}')`).run();
  db.query(`INSERT INTO pi_usage VALUES ('s','usage',2,'root',0,'{"input":1}',NULL)`).run();
  db.query(`INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES ('s','committed',1,'["write"]')`).run();
  db.query(`INSERT INTO node_attachments VALUES ('s','img','image/png',1,'sha',NULL,NULL,NULL,x'00')`).run();
  runNodeMigrations(db);
  expect(nodeSessionBinding(db, "s")).toEqual(binding);
  expect(nodeSessionTask(db, "s")).toBeNull();
  expect(db.query("SELECT harness_next_seq FROM sessions WHERE id='s'").get()).toEqual({ harness_next_seq: 3 });
  expect(db.query("SELECT harness_id FROM session_messages").get()).toEqual({ harness_id: "root" });
  expect(db.query("SELECT value_json FROM pi_values").get()).toEqual({ value_json: '"root"' });
  expect(db.query("SELECT value_json FROM pi_lists").get()).toEqual({ value_json: '{"id":1}' });
  expect(db.query("SELECT usage_json FROM pi_usage").get()).toEqual({ usage_json: '{"input":1}' });
  expect(db.query("SELECT payload FROM session_outbox").get()).toEqual({ payload: '["write"]' });
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'admission_receipts'").get()).toBeNull();
  expect(hydrateCachedPrompt(db, "s", [{ type: "image", attachmentId: "img", mimeType: "image/png", byteSize: 1, sha256: "sha" }]))
    .toEqual([{ type: "image", data: "AA==", mimeType: "image/png" }]);
  db.close();
});

test("versioned node migrations add attachments, move pending commits into the ordered outbox and drop admission receipts without changing canonical records", () => {
  const dir = mkdtempSync(join(tmpdir(), "reins-node-migration-"));
  try {
    const path = join(dir, "storage.db");
    const old = new Database(path);
    old.exec(versionOne + ledger);
    old.query("INSERT INTO sessions VALUES ('s',7,'/tmp/node','2026-04-01',NULL,4)").run();
    old.query("INSERT INTO pending_commits VALUES ('s',2,'[\"second\"]'),('s',1,'[\"write\"]')").run();
    old.query("INSERT INTO admission_receipts VALUES ('command','s','provision','payload')").run();
    old.close();
    const upgraded = new Database(path);
    runNodeMigrations(upgraded);
    upgraded.close();
    const reopened = new Database(path);
    runNodeMigrations(reopened);
    expect(applied(reopened)).toEqual(["001_canonical_node_storage", "002_node_attachments", "003_session_outbox", "004_session_task", "005_attachment_uploads", "006_node_attachment_content", "007_drop_admission_receipts"]);
    expect(nodeSessionBinding(reopened, "s")).toEqual(binding);
    expect(nodeSessionTask(reopened, "s")).toBeNull();
    expect(reopened.query("SELECT harness_next_seq FROM sessions WHERE id='s'").get()).toEqual({ harness_next_seq: 4 });
    // Commands converge on their own state: the receipts are dropped with the table.
    expect(reopened.query("SELECT name FROM sqlite_master WHERE name = 'admission_receipts'").get()).toBeNull();
    expect(reopened.query("SELECT kind, start_seq, payload, ready FROM session_outbox ORDER BY id").all()).toEqual([
      { kind: "committed", start_seq: 1, payload: '["write"]', ready: 1 },
      { kind: "committed", start_seq: 2, payload: '["second"]', ready: 1 },
    ]);
    expect(reopened.query("SELECT name FROM sqlite_master WHERE name='pending_commits'").get()).toBeNull();
    reopened.query(`INSERT INTO node_attachments VALUES ('s','img','image/png',1,'sha',NULL,NULL,NULL,x'00')`).run();
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("004_session_task adds a nullable, JSON-checked task snapshot to existing sessions", () => {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  // Reconstruct the 003 schema: the ledger, not schema text, decides what runs.
  db.exec("ALTER TABLE sessions DROP COLUMN task_json; DELETE FROM migrations WHERE name = '004_session_task'");
  db.query("INSERT INTO sessions VALUES ('s',7,'/tmp/node','2026-04-01',NULL,4)").run();
  runNodeMigrations(db);
  expect(applied(db)).toEqual(["001_canonical_node_storage", "002_node_attachments", "003_session_outbox", "004_session_task", "005_attachment_uploads", "006_node_attachment_content", "007_drop_admission_receipts"]);
  expect(nodeSessionBinding(db, "s")).toEqual(binding);
  expect(nodeSessionTask(db, "s")).toBeNull();
  expect(db.query("SELECT harness_next_seq FROM sessions WHERE id='s'").get()).toEqual({ harness_next_seq: 4 });
  expect(() => db.query("UPDATE sessions SET task_json = 'not json' WHERE id = 's'").run()).toThrow();
  db.close();
});

test("005_attachment_uploads lets the session outbox hold attachment uploads, keeping its rows, order and ID sequence", () => {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  // Reconstruct the 004 outbox: the ledger, not schema text, decides what runs.
  db.exec(`DROP TABLE session_outbox; DELETE FROM migrations WHERE name = '005_attachment_uploads';
    CREATE TABLE session_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('committed', 'started', 'settled')),
      start_seq INTEGER, payload TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 1 CHECK(ready IN (0, 1)),
      CHECK((kind = 'committed') = (start_seq IS NOT NULL)));
    CREATE UNIQUE INDEX session_outbox_commit ON session_outbox(session_id, start_seq) WHERE kind = 'committed';
    CREATE INDEX session_outbox_order ON session_outbox(session_id, id);`);
  bindNodeSession(db, "s", binding);
  db.exec(`INSERT INTO session_outbox(id,session_id,kind,start_seq,payload,ready) VALUES
    (3,'s','committed',1,'["write"]',1), (4,'s','settled',NULL,'{"runId":"r"}',0), (9,'s','started',NULL,'{"runId":"x"}',1);
    DELETE FROM session_outbox WHERE id = 9`);
  expect(() => db.query(`INSERT INTO session_outbox(session_id,kind,payload) VALUES ('s','attachment','{}')`).run()).toThrow();
  runNodeMigrations(db);
  expect(applied(db)).toContain("005_attachment_uploads");
  expect(db.query("SELECT id, kind, start_seq, payload, ready FROM session_outbox ORDER BY id").all()).toEqual([
    { id: 3, kind: "committed", start_seq: 1, payload: '["write"]', ready: 1 },
    { id: 4, kind: "settled", start_seq: null, payload: '{"runId":"r"}', ready: 0 },
  ]);
  // New rows still sort after every row ever recorded, and commits stay unique per start_seq.
  const next = db.query(`INSERT INTO session_outbox(session_id,kind,payload) VALUES ('s','attachment','{"attachmentId":"att_1"}')`).run();
  expect(Number(next.lastInsertRowid)).toBe(10);
  expect(() => db.query(`INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES ('s','committed',1,'[]')`).run()).toThrow();
  expect(() => db.query(`INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES ('s','attachment',2,'{}')`).run()).toThrow();
  expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('session_outbox_commit','session_outbox_order') ORDER BY name").all())
    .toEqual([{ name: "session_outbox_commit" }, { name: "session_outbox_order" }]);
  db.close();
});

test("006_node_attachment_content indexes cached attachments by content, keeping their rows", () => {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  // Reconstruct the 005 schema: the ledger, not schema text, decides what runs.
  db.exec("DROP INDEX node_attachments_content; DELETE FROM migrations WHERE name = '006_node_attachment_content'");
  bindNodeSession(db, "s", binding);
  db.query(`INSERT INTO node_attachments VALUES ('s','img','image/png',1,'sha',NULL,NULL,NULL,x'00')`).run();
  runNodeMigrations(db);
  expect(applied(db)).toContain("006_node_attachment_content");
  expect(db.query("SELECT attachment_id FROM node_attachments").all()).toEqual([{ attachment_id: "img" }]);
  expect(db.query("EXPLAIN QUERY PLAN SELECT attachment_id FROM node_attachments WHERE session_id = 's' AND sha256 = 'sha' AND mime_type = 'image/png'").all())
    .toContainEqual(expect.objectContaining({ detail: expect.stringContaining("node_attachments_content") }));
  db.close();
});

test("unversioned nonempty node databases fail closed even if they resemble the new schema", () => {
  const db = new Database(":memory:");
  db.exec(versionOne);
  db.query("INSERT INTO sessions VALUES ('s',7,'/tmp/node','2026-04-01',NULL,4)").run();
  expect(() => runNodeMigrations(db)).toThrow(/unversioned/i);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='migrations'").get()).toBeNull();
  expect(db.query("SELECT harness_next_seq FROM sessions WHERE id='s'").get()).toEqual({ harness_next_seq: 4 });
  expect(db.query("SELECT name FROM sqlite_master WHERE name='node_attachments'").get()).toBeNull();
  db.close();
});

test("migration ledger, not reconstructed schema text, determines what runs", () => {
  const db = new Database(":memory:");
  db.exec(versionOne + ledger + " CREATE TABLE unrelated_local_table (id INTEGER PRIMARY KEY)");
  runNodeMigrations(db);
  expect(applied(db)).toEqual(["001_canonical_node_storage", "002_node_attachments", "003_session_outbox", "004_session_task", "005_attachment_uploads", "006_node_attachment_content", "007_drop_admission_receipts"]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='unrelated_local_table'").get())
    .toEqual({ name: "unrelated_local_table" });
  db.close();
});

test("a failed migration leaves its ledger record unapplied", () => {
  const db = new Database(":memory:");
  db.exec(versionOne + ledger + " CREATE TABLE node_attachments (unrelated TEXT)");
  expect(() => runNodeMigrations(db)).toThrow();
  expect(applied(db)).toEqual(["001_canonical_node_storage"]);
  db.close();
});

test("an unknown migration record fails startup without changing the database", () => {
  const db = new Database(":memory:");
  db.exec(versionOne + ledger + " INSERT INTO migrations(name) VALUES ('999_future')");
  expect(() => runNodeMigrations(db)).toThrow("Unknown node migration");
  expect(applied(db)).toEqual(["001_canonical_node_storage", "999_future"]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='node_attachments'").get()).toBeNull();
  db.close();
});

test("binding never initializes node schema on its own", () => {
  const db = new Database(":memory:");
  expect(() => bindNodeSession(db, "s", binding)).toThrow();
  expect(db.query("SELECT name FROM sqlite_master WHERE name='migrations'").get()).toBeNull();
  db.close();
});
