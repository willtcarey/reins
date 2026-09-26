import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindNodeSession, initializeNodeStorage, nodeAdmissionReceipt, nodeSessionBinding, nodeSessionTask, provisionNodeSession } from "./storage.js";
import { hydrateCachedPrompt } from "./runtime/attachments.js";

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

test("fresh node storage initializes bindings, task snapshots, canonical state, receipts and attachments", () => {
  const db = new Database(":memory:");
  initializeNodeStorage(db);
  expect(applied(db)).toEqual(["001_canonical_node_storage", "002_node_attachments", "003_session_outbox", "004_session_task"]);
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
  db.query(`INSERT INTO admission_receipts VALUES ('command','s','provision','payload')`).run();
  db.query(`INSERT INTO node_attachments VALUES ('s','img','image/png',1,'sha',NULL,NULL,NULL,x'00')`).run();
  initializeNodeStorage(db);
  expect(nodeSessionBinding(db, "s")).toEqual(binding);
  expect(nodeSessionTask(db, "s")).toBeNull();
  expect(db.query("SELECT harness_next_seq FROM sessions WHERE id='s'").get()).toEqual({ harness_next_seq: 3 });
  expect(db.query("SELECT harness_id FROM session_messages").get()).toEqual({ harness_id: "root" });
  expect(db.query("SELECT value_json FROM pi_values").get()).toEqual({ value_json: '"root"' });
  expect(db.query("SELECT value_json FROM pi_lists").get()).toEqual({ value_json: '{"id":1}' });
  expect(db.query("SELECT usage_json FROM pi_usage").get()).toEqual({ usage_json: '{"input":1}' });
  expect(db.query("SELECT payload FROM session_outbox").get()).toEqual({ payload: '["write"]' });
  expect(nodeAdmissionReceipt(db, "command")?.payload).toBe("payload");
  expect(hydrateCachedPrompt(db, "s", [{ type: "image", attachmentId: "img", mimeType: "image/png", byteSize: 1, sha256: "sha" }]))
    .toEqual([{ type: "image", data: "AA==", mimeType: "image/png" }]);
  db.close();
});

test("versioned node migrations add attachments and move pending commits into the ordered outbox without changing canonical records", () => {
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
    initializeNodeStorage(upgraded);
    upgraded.close();
    const reopened = new Database(path);
    initializeNodeStorage(reopened);
    expect(applied(reopened)).toEqual(["001_canonical_node_storage", "002_node_attachments", "003_session_outbox", "004_session_task"]);
    expect(nodeSessionBinding(reopened, "s")).toEqual(binding);
    expect(nodeSessionTask(reopened, "s")).toBeNull();
    expect(reopened.query("SELECT harness_next_seq FROM sessions WHERE id='s'").get()).toEqual({ harness_next_seq: 4 });
    expect(nodeAdmissionReceipt(reopened, "command")?.payload).toBe("payload");
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
  initializeNodeStorage(db);
  // Reconstruct the 003 schema: the ledger, not schema text, decides what runs.
  db.exec("ALTER TABLE sessions DROP COLUMN task_json; DELETE FROM migrations WHERE name = '004_session_task'");
  db.query("INSERT INTO sessions VALUES ('s',7,'/tmp/node','2026-04-01',NULL,4)").run();
  initializeNodeStorage(db);
  expect(applied(db)).toEqual(["001_canonical_node_storage", "002_node_attachments", "003_session_outbox", "004_session_task"]);
  expect(nodeSessionBinding(db, "s")).toEqual(binding);
  expect(nodeSessionTask(db, "s")).toBeNull();
  expect(db.query("SELECT harness_next_seq FROM sessions WHERE id='s'").get()).toEqual({ harness_next_seq: 4 });
  expect(() => db.query("UPDATE sessions SET task_json = 'not json' WHERE id = 's'").run()).toThrow();
  db.close();
});

test("unversioned nonempty node databases fail closed even if they resemble the new schema", () => {
  const db = new Database(":memory:");
  db.exec(versionOne);
  db.query("INSERT INTO sessions VALUES ('s',7,'/tmp/node','2026-04-01',NULL,4)").run();
  expect(() => initializeNodeStorage(db)).toThrow(/unversioned/i);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='migrations'").get()).toBeNull();
  expect(db.query("SELECT harness_next_seq FROM sessions WHERE id='s'").get()).toEqual({ harness_next_seq: 4 });
  expect(db.query("SELECT name FROM sqlite_master WHERE name='node_attachments'").get()).toBeNull();
  db.close();
});

test("migration ledger, not reconstructed schema text, determines what runs", () => {
  const db = new Database(":memory:");
  db.exec(versionOne + ledger + " CREATE TABLE unrelated_local_table (id INTEGER PRIMARY KEY)");
  initializeNodeStorage(db);
  expect(applied(db)).toEqual(["001_canonical_node_storage", "002_node_attachments", "003_session_outbox", "004_session_task"]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='unrelated_local_table'").get())
    .toEqual({ name: "unrelated_local_table" });
  db.close();
});

test("a failed migration leaves its ledger record unapplied", () => {
  const db = new Database(":memory:");
  db.exec(versionOne + ledger + " CREATE TABLE node_attachments (unrelated TEXT)");
  expect(() => initializeNodeStorage(db)).toThrow();
  expect(applied(db)).toEqual(["001_canonical_node_storage"]);
  db.close();
});

test("an unknown migration record fails startup without changing the database", () => {
  const db = new Database(":memory:");
  db.exec(versionOne + ledger + " INSERT INTO migrations(name) VALUES ('999_future')");
  expect(() => initializeNodeStorage(db)).toThrow("Unknown node migration");
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
