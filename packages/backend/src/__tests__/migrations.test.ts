import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runMigrations } from "../migrations.js";
import { setDb, resetDb } from "../db.js";
import { createProject } from "./project-fixture.js";
import { createSession } from "../session-store.js";
import { defaultSource } from "../node-store.js";

function createLegacySchema(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      base_branch TEXT NOT NULL DEFAULT 'main'
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      model_provider TEXT,
      model_id TEXT,
      thinking_level TEXT DEFAULT 'off',
      task_id INTEGER,
      parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      agent_runtime_type TEXT NOT NULL DEFAULT 'pi'
    );

    CREATE TABLE session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      message_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, seq)
    );

    CREATE TABLE session_attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      filename TEXT,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      data BLOB,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      pruned_at TEXT,
      width INTEGER,
      height INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      UNIQUE (session_id, sha256, mime_type)
    );

    INSERT INTO migrations (name)
    VALUES
      ('001_create_projects'),
      ('002_add_base_branch'),
      ('003_create_sessions'),
      ('004_create_session_messages'),
      ('005_session_indexes'),
      ('006_create_tasks'),
      ('007_add_session_task_id'),
      ('008_add_task_status'),
      ('009_timestamps_utc_suffix'),
      ('010_rename_task_status_merged_to_closed'),
      ('011_add_task_base_commit'),
      ('012_add_parent_session_id'),
      ('013_remove_duplicate_compaction_markers'),
      ('014_create_settings'),
      ('015_create_auth_credentials'),
      ('016_add_session_agent_runtime_type'),
      ('017_rename_thinking_signature'),
      ('018_create_session_attachments'),
      ('019_add_session_attachment_dimensions');

    INSERT INTO projects (id, name, path) VALUES (1, 'Legacy Project', '/tmp/legacy-project');
    INSERT INTO sessions (id, project_id, agent_runtime_type) VALUES ('sess-legacy', 1, 'pi');
  `);
}

/** The outbox as 030/031 created it (before 039 narrowed its states); the table must be empty. */
function restoreOutboxBefore039(db: Database): void {
  db.exec(`DELETE FROM migrations WHERE name = '039_outbox_queue_states';
    DROP TABLE node_command_outbox;
    CREATE TABLE node_command_outbox (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      command_json TEXT NOT NULL CHECK(json_valid(command_json)),
      state TEXT NOT NULL CHECK(state IN ('queued', 'dispatching', 'admitted', 'failed', 'unknown')),
      result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_node_command_outbox_state ON node_command_outbox(state, created_at);
    CREATE UNIQUE INDEX idx_node_command_outbox_session_provision ON node_command_outbox(session_id) WHERE json_extract(command_json, '$.op') = 'session.provision';
    CREATE UNIQUE INDEX idx_node_command_client_id ON node_command_outbox(session_id, json_extract(command_json, '$.clientId'))
      WHERE json_extract(command_json, '$.clientId') IS NOT NULL;`);
}

function insertMessage(db: Database, seq: number, role: string, message: unknown): void {
  db.query(
    "INSERT INTO session_messages (session_id, seq, role, message_json) VALUES ('sess-legacy', ?, ?, ?)",
  ).run(seq, role, JSON.stringify(message));
}

describe("migrations", () => {
  test("fresh schema supports node-owned sessions without follow-up migrations", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      const applied = db.query<{ name: string }, []>("SELECT name FROM migrations WHERE name >= '030' ORDER BY name").all().map(row => row.name);
      expect(applied).not.toContain("033_upgrade_node_open_commands");
      expect(applied).not.toContain("034_session_storage_owner");

      const project = createProject("Existing schema", "/tmp/existing-schema");
      const created = createSession("new-node-session", project.id, {
        sourceId: defaultSource(project.id)!.id, agentRuntimeType: "pi",
      });
      expect(created).toMatchObject({ run_id: null, settlement_count: 0, settlement_json: null, settlement_next_seq: null });
      for (const retired of ["storage_owner", "placement_status", "status_error"]) expect(created).not.toHaveProperty(retired);
    } finally {
      resetDb();
    }
  });

  test("backfills linear message ancestry and enforces nullable per-session harness identities", () => {
    const db = new Database(":memory:");
    try {
      createLegacySchema(db);
      insertMessage(db, 0, "user", { role: "user", content: [] });
      insertMessage(db, 4, "assistant", { role: "assistant", content: [] });
      insertMessage(db, 9, "user", { role: "user", content: [] });
      db.exec(`
        INSERT INTO sessions (id, project_id, agent_runtime_type) VALUES ('sess-other', 1, 'pi');
        INSERT INTO session_messages (session_id, seq, role, message_json)
        VALUES ('sess-other', 2, 'user', '{"role":"user","content":[]}');
      `);

      runMigrations(db);

      const piTables = db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_%' ORDER BY name",
      ).all().map((row) => row.name);
      expect(piTables).toEqual(["pi_lists", "pi_usage", "pi_values"]);

      const rows = db.query<{
        id: number;
        session_id: string;
        seq: number;
        parent_id: number | null;
        harness_id: string | null;
      }, []>(
        "SELECT id, session_id, seq, parent_id, harness_id FROM session_messages ORDER BY session_id, seq",
      ).all();
      const legacyRows = rows.filter((row) => row.session_id === "sess-legacy");
      const otherRow = rows.find((row) => row.session_id === "sess-other")!;

      expect(legacyRows.map((row) => ({ seq: row.seq, parent_id: row.parent_id, harness_id: row.harness_id }))).toEqual([
        { seq: 0, parent_id: null, harness_id: null },
        { seq: 4, parent_id: legacyRows[0].id, harness_id: null },
        { seq: 9, parent_id: legacyRows[1].id, harness_id: null },
      ]);
      expect(otherRow).toMatchObject({ seq: 2, parent_id: null, harness_id: null });

      const parentForeignKey = db.query<{
        from: string;
        table: string;
        to: string;
        on_delete: string;
      }, []>("PRAGMA foreign_key_list('session_messages')").all()
        .find((foreignKey) => foreignKey.from === "parent_id");
      expect(parentForeignKey).toMatchObject({
        table: "session_messages",
        to: "id",
        on_delete: "SET NULL",
      });

      db.query("UPDATE session_messages SET harness_id = 'entry-1' WHERE id = ?").run(legacyRows[0].id);
      expect(() => db.query("UPDATE session_messages SET harness_id = 'entry-1' WHERE id = ?").run(legacyRows[1].id)).toThrow();
      db.query("UPDATE session_messages SET harness_id = 'entry-1' WHERE id = ?").run(otherRow.id);

      db.query("DELETE FROM session_messages WHERE id = ?").run(legacyRows[1].id);
      expect(db.query<{ parent_id: number | null }, [number]>(
        "SELECT parent_id FROM session_messages WHERE id = ?",
      ).get(legacyRows[2].id)?.parent_id).toBeNull();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("externalizes inline persisted images and canonicalizes string content", () => {
    const db = new Database(":memory:");
    try {
      createLegacySchema(db);
      const imageBytes = Buffer.from("legacy image");
      const imageData = imageBytes.toString("base64");
      const sha256 = createHash("sha256").update(imageBytes).digest("hex");

      insertMessage(db, 0, "user", {
        role: "user",
        content: "hello as a string",
        timestamp: 1,
      });
      insertMessage(db, 1, "toolResult", {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read",
        isError: false,
        content: [
          { type: "text", text: "look" },
          { type: "image", data: imageData, mimeType: "image/png", filename: "legacy.png", width: 64, height: 32 },
        ],
        timestamp: 2,
      });
      insertMessage(db, 2, "toolResult", {
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "read",
        isError: false,
        content: [
          { type: "image", data: imageData, mimeType: "image/png", filename: "duplicate.png" },
        ],
        timestamp: 3,
      });
      insertMessage(db, 3, "compactionSummary", {
        role: "compactionSummary",
        summary: "summary text",
        content: "summary text",
        timestamp: 4,
      });

      runMigrations(db);

      const applied = db
        .query<{ name: string }, []>("SELECT name FROM migrations WHERE name = '020_canonicalize_message_content'")
        .get();
      expect(applied?.name).toBe("020_canonicalize_message_content");

      const user = JSON.parse(db.query<{ message_json: string }, []>("SELECT message_json FROM session_messages WHERE seq = 0").get()!.message_json);
      expect(user.content).toEqual([{ type: "text", text: "hello as a string" }]);

      const firstTool = JSON.parse(db.query<{ message_json: string }, []>("SELECT message_json FROM session_messages WHERE seq = 1").get()!.message_json);
      expect(firstTool.content[1]).toMatchObject({
        type: "image",
        mimeType: "image/png",
        filename: "legacy.png",
        byteSize: imageBytes.length,
        sha256,
        width: 64,
        height: 32,
      });
      expect(firstTool.content[1].attachmentId).toStartWith("att_");
      expect(firstTool.content[1].data).toBeUndefined();

      const secondTool = JSON.parse(db.query<{ message_json: string }, []>("SELECT message_json FROM session_messages WHERE seq = 2").get()!.message_json);
      expect(secondTool.content[0].attachmentId).toBe(firstTool.content[1].attachmentId);
      expect(secondTool.content[0].data).toBeUndefined();

      const attachments = db
        .query<{ id: string; mime_type: string; filename: string | null; byte_size: number; sha256: string; data: Buffer; width: number | null; height: number | null }, []>(
          "SELECT id, mime_type, filename, byte_size, sha256, data, width, height FROM session_attachments",
        )
        .all();
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatchObject({
        id: firstTool.content[1].attachmentId,
        mime_type: "image/png",
        filename: "legacy.png",
        byte_size: imageBytes.length,
        sha256,
        width: 64,
        height: 32,
      });
      expect(Buffer.from(attachments[0].data).toString()).toBe("legacy image");

      const summary = JSON.parse(db.query<{ message_json: string }, []>("SELECT message_json FROM session_messages WHERE seq = 3").get()!.message_json);
      expect(summary.summary).toBe("summary text");
      expect(summary.content).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("034 lets a session hold identical bytes under several attachment IDs and keeps existing attachments", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // Reconstruct the 033 table: the ledger decides what runs.
      db.exec(`DROP TABLE session_attachments; DELETE FROM migrations WHERE name = '034_session_attachment_node_ids';
        CREATE TABLE session_attachments (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, mime_type TEXT NOT NULL,
          filename TEXT, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), pruned_at TEXT,
          width INTEGER, height INTEGER,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE, UNIQUE (session_id, sha256, mime_type));
        CREATE INDEX idx_session_attachments_session ON session_attachments(session_id, created_at DESC);`);
      const project = createProject("Attachments", "/tmp/attachments-034");
      createSession("s", project.id, { sourceId: defaultSource(project.id)!.id, agentRuntimeType: "pi" });
      db.exec(`INSERT INTO session_attachments VALUES ('att_old','s','image','image/png','a.png',3,'sha',x'010203','2026-01-01T00:00:00.000Z',NULL,4,5);
        INSERT INTO session_attachments VALUES ('att_pruned','s','image','image/gif',NULL,1,'sha2',NULL,'2026-01-02T00:00:00.000Z','2026-01-03T00:00:00.000Z',NULL,NULL)`);
      expect(() => db.exec("INSERT INTO session_attachments(id,session_id,kind,mime_type,byte_size,sha256) VALUES ('att_new','s','image','image/png',3,'sha')")).toThrow();

      runMigrations(db);
      expect(db.query("SELECT * FROM session_attachments ORDER BY id").all()).toEqual([
        { id: "att_old", session_id: "s", kind: "image", mime_type: "image/png", filename: "a.png", byte_size: 3, sha256: "sha",
          data: new Uint8Array([1, 2, 3]), created_at: "2026-01-01T00:00:00.000Z", pruned_at: null, width: 4, height: 5 },
        { id: "att_pruned", session_id: "s", kind: "image", mime_type: "image/gif", filename: null, byte_size: 1, sha256: "sha2",
          data: null, created_at: "2026-01-02T00:00:00.000Z", pruned_at: "2026-01-03T00:00:00.000Z", width: null, height: null },
      ]);
      db.exec("INSERT INTO session_attachments(id,session_id,kind,mime_type,byte_size,sha256) VALUES ('att_new','s','image','image/png',3,'sha')");
      expect(() => db.exec("INSERT INTO session_attachments(id,session_id,kind,mime_type,byte_size,sha256) VALUES ('att_new','s','image','image/png',3,'sha')")).toThrow();
      expect(() => db.exec("INSERT INTO session_attachments(id,session_id,kind,mime_type,byte_size,sha256) VALUES ('att_x','missing','image','image/png',3,'sha')")).toThrow();
      db.exec("DELETE FROM sessions WHERE id = 's'");
      expect(db.query("SELECT COUNT(*) AS n FROM session_attachments").get()).toEqual({ n: 0 });
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_attachments' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
        .toEqual([{ name: "idx_session_attachments_content" }, { name: "idx_session_attachments_session" }]);
    } finally {
      resetDb();
    }
  });
  test("039 narrows the outbox to queue states, keeping every row in delivery order with its indexes and FK", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      restoreOutboxBefore039(db);
      const project = createProject("Outbox", "/tmp/outbox-039");
      const source = defaultSource(project.id)!.id;
      for (const id of ["a", "b"]) db.query("INSERT INTO sessions (id, project_id, source_id, agent_runtime_type) VALUES (?, ?, ?, 'pi')").run(id, project.id, source);
      const command = (id: string, sessionId: string, state: string, json: unknown, result: unknown = null) =>
        db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state, result_json, created_at) VALUES (?, ?, ?, ?, ?, '2026-01-01 00:00:00')")
          .run(id, sessionId, JSON.stringify(json), state, result === null ? null : JSON.stringify(result));
      // IDs out of rowid order: delivery follows rowid.
      command("z", "a", "dispatching", { op: "session.prompt", clientId: "one", content: [] });
      command("y", "b", "queued", { op: "session.provision", configuration: { model: null, thinkingLevel: null, task: null } });
      command("x", "a", "queued", { op: "session.prompt", clientId: "two", content: [] });
      command("w", "a", "failed", { op: "session.setModel", provider: "p", modelId: "m" }, { ok: false, error: { code: "internal", message: "no", retryable: false } });
      const before = db.query("SELECT rowid, * FROM node_command_outbox ORDER BY rowid").all();

      runMigrations(db);

      expect(db.query("SELECT rowid, * FROM node_command_outbox ORDER BY rowid").all()).toEqual(before);
      expect(() => db.exec("UPDATE node_command_outbox SET state = 'admitted' WHERE id = 'x'")).toThrow();
      expect(() => db.exec("UPDATE node_command_outbox SET state = 'unknown' WHERE id = 'x'")).toThrow();
      const indexes = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'node_command_outbox' AND sql IS NOT NULL ORDER BY name").all();
      expect(indexes.map(index => index.name)).toEqual(["idx_node_command_client_id", "idx_node_command_outbox_session_provision", "idx_node_command_outbox_state"]);
      expect(() => command("v", "a", "queued", { op: "session.prompt", clientId: "two", content: [] })).toThrow();
      expect(() => command("u", "b", "queued", { op: "session.provision", configuration: {} })).toThrow();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      db.exec("DELETE FROM sessions WHERE id = 'a'");
      expect(db.query("SELECT id FROM node_command_outbox").all()).toEqual([{ id: "y" }]);
    } finally {
      resetDb();
    }
  });

  test("041 drops provision and hydrate commands left from before the cutover, and the node deletion records", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // As 039 and 040 left the schema.
      db.exec(`DELETE FROM migrations WHERE name = '041_drop_replica_commands_and_node_deletions';
        CREATE UNIQUE INDEX idx_node_command_outbox_session_provision ON node_command_outbox(session_id) WHERE json_extract(command_json, '$.op') = 'session.provision';
        CREATE TABLE node_session_deletions (session_id TEXT NOT NULL, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, PRIMARY KEY (session_id, node_id));
        CREATE TRIGGER sessions_node_deletions AFTER DELETE ON sessions BEGIN
          INSERT OR IGNORE INTO node_session_deletions (session_id, node_id) SELECT OLD.id, id FROM nodes;
        END;`);
      const project = createProject("Cutover", "/tmp/cutover-041");
      createSession("s", project.id, { sourceId: defaultSource(project.id)!.id, agentRuntimeType: "pi" });
      createSession("gone", project.id, { sourceId: defaultSource(project.id)!.id, agentRuntimeType: "pi" });
      const command = (id: string, state: string, json: unknown) =>
        db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES (?, 's', ?, ?)").run(id, JSON.stringify(json), state);
      command("provision", "queued", { op: "session.provision", configuration: { model: null, thinkingLevel: null, task: null } });
      command("hydrate", "dispatching", { op: "session.hydrate", targetSourceId: 1 });
      command("prompt", "queued", { op: "session.prompt", clientId: "c", content: [], sourceSessionId: null });
      db.exec("DELETE FROM sessions WHERE id = 'gone'");

      runMigrations(db);

      expect(db.query("SELECT id FROM node_command_outbox").all()).toEqual([{ id: "prompt" }]);
      const leftover = db.query("SELECT name FROM sqlite_master WHERE name IN ('idx_node_command_outbox_session_provision', 'node_session_deletions', 'sessions_node_deletions')").all();
      expect(leftover).toEqual([]);
      db.exec("DELETE FROM sessions WHERE id = 's'");
      expect(db.query("SELECT id FROM sessions").all()).toEqual([]);
    } finally {
      resetDb();
    }
  });
  test("042 moves the run in progress and the latest settlement onto the session row and drops the watermarks and placement columns", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // As 041 left the schema.
      db.exec(`DELETE FROM migrations WHERE name = '042_session_runs_on_sessions';
        ALTER TABLE sessions DROP COLUMN run_id; ALTER TABLE sessions DROP COLUMN settlement_count;
        ALTER TABLE sessions DROP COLUMN settlement_json; ALTER TABLE sessions DROP COLUMN settlement_next_seq;
        ALTER TABLE sessions ADD COLUMN placement_status TEXT NOT NULL DEFAULT 'server'
          CHECK(placement_status IN ('server', 'provisioning', 'provisioned', 'provision_failed', 'moving'));
        ALTER TABLE sessions ADD COLUMN status_error TEXT;
        CREATE TABLE node_session_watermarks (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          commit_start_seq INTEGER, commit_sha256 TEXT,
          report_run_id TEXT, report_kind TEXT CHECK(report_kind IN ('started', 'settled')), report_sha256 TEXT,
          settlement_count INTEGER NOT NULL DEFAULT 0,
          settlement_json TEXT CHECK(settlement_json IS NULL OR json_valid(settlement_json)),
          settlement_next_seq INTEGER);`);
      const project = createProject("Runs", "/tmp/runs-042");
      const source = defaultSource(project.id)!.id;
      for (const id of ["running", "settled", "never"]) {
        db.query("INSERT INTO sessions (id, project_id, source_id, agent_runtime_type, placement_status) VALUES (?, ?, ?, 'pi', 'provisioned')").run(id, project.id, source);
      }
      db.exec(`INSERT INTO node_session_watermarks (session_id, report_run_id, report_kind, settlement_count, settlement_json, settlement_next_seq)
        VALUES ('running', 'r2', 'started', 1, '{"status":"completed"}', 4), ('settled', 'r1', 'settled', 2, '{"status":"failed","error":{"message":"x"}}', 9)`);

      runMigrations(db);

      expect(db.query("SELECT id, run_id, settlement_count, settlement_json, settlement_next_seq FROM sessions ORDER BY id").all()).toEqual([
        { id: "never", run_id: null, settlement_count: 0, settlement_json: null, settlement_next_seq: null },
        { id: "running", run_id: "r2", settlement_count: 1, settlement_json: '{"status":"completed"}', settlement_next_seq: 4 },
        { id: "settled", run_id: null, settlement_count: 2, settlement_json: '{"status":"failed","error":{"message":"x"}}', settlement_next_seq: 9 },
      ]);
      const columns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('sessions')").all().map(column => column.name);
      expect(columns).not.toContain("placement_status");
      expect(columns).not.toContain("status_error");
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'node_session_watermarks'").get()).toBeNull();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      resetDb();
    }
  });

  test("043 and 044 leave a project's sources to its creator: no triggers, and the path lives on sources only", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'internal_project_source_%'").all()).toEqual([]);
      expect(db.query("SELECT name FROM pragma_table_info('projects')").all().map((column: any) => column.name)).not.toContain("path");
      const bare = db.query<{ id: number }, []>("INSERT INTO projects (name) VALUES ('Bare') RETURNING id").get()!;
      expect(db.query("SELECT * FROM sources WHERE project_id = ?").all(bare.id)).toEqual([]);
    } finally {
      resetDb();
    }
  });

  test("044 rebuilds projects without their path, keeping every row and what references it, and makes a checkout belong to one project", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // As 043 left the schema: projects with their path.
      db.exec(`PRAGMA foreign_keys = OFF;
        DELETE FROM migrations WHERE name = '044_paths_belong_to_sources';
        DROP INDEX idx_sources_checkout;
        CREATE TABLE projects_043 (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), last_opened_at TEXT NOT NULL DEFAULT (datetime('now')),
          base_branch TEXT NOT NULL DEFAULT 'main');
        DROP TABLE projects;
        ALTER TABLE projects_043 RENAME TO projects;
        PRAGMA foreign_keys = ON;
        INSERT INTO projects (id, name, path, base_branch) VALUES (7, 'Kept', '/tmp/kept-044', 'develop');
        INSERT INTO sources (project_id, node_id, path) VALUES (7, 'internal', '/tmp/kept-044');`);
      const source = defaultSource(7)!;
      createSession("s", 7, { sourceId: source.id, agentRuntimeType: "pi" });

      runMigrations(db);

      expect(db.query("SELECT id, name, base_branch FROM projects").all()).toEqual([{ id: 7, name: "Kept", base_branch: "develop" }]);
      expect(db.query("SELECT id, project_id, source_id FROM sessions").all()).toEqual([{ id: "s", project_id: 7, source_id: source.id }]);
      expect(defaultSource(7)).toEqual(source);
      expect(() => db.exec("INSERT INTO projects (name) VALUES ('Other'); INSERT INTO sources (project_id, node_id, path) VALUES (last_insert_rowid(), 'internal', '/tmp/kept-044')")).toThrow("UNIQUE constraint");
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      resetDb();
    }
  });
});
