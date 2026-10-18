import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runMigrations } from "../migrations.js";
import { setDb, resetDb } from "../app-globals.js";
import { createProject } from "./project-fixture.js";
import { createSession } from "../session-store.js";
import { defaultSource } from "../node-store.js";
import { getTask } from "../task-store.js";

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

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      branch_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'open'
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
      expect(created).toMatchObject({ settlement_json: null, auto_resumes: null });
      for (const retired of ["storage_owner", "placement_status", "status_error", "run_id", "run_started_at", "settlement_count", "settlement_next_seq"]) expect(created).not.toHaveProperty(retired);
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
  test("042 moves the latest settlement onto the session row and drops the watermarks and placement columns (and 057 the run copy it moved)", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // As 041 left the schema, with 048's run start (which 057 drops) and 057 to apply again.
      db.exec(`DELETE FROM migrations WHERE name IN ('042_session_runs_on_sessions', '057_drop_session_run_copy');
        ALTER TABLE sessions DROP COLUMN settlement_json; ALTER TABLE sessions ADD COLUMN run_started_at TEXT;
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

      expect(db.query("SELECT id, settlement_json FROM sessions ORDER BY id").all()).toEqual([
        { id: "never", settlement_json: null },
        { id: "running", settlement_json: '{"status":"completed"}' },
        { id: "settled", settlement_json: '{"status":"failed","error":{"message":"x"}}' },
      ]);
      const columns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('sessions')").all().map(column => column.name);
      for (const dropped of ["placement_status", "status_error", "run_id", "settlement_count", "settlement_next_seq"]) expect(columns).not.toContain(dropped);
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

  test("045 keeps existing sessions in the foreground and stores background as 0 or 1", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // As 044 left the schema: sessions without the column.
      db.exec(`DELETE FROM migrations WHERE name = '045_background_sessions';
        ALTER TABLE sessions DROP COLUMN background;`);
      const project = createProject("Background", "/tmp/background-045");
      const source = defaultSource(project.id)!.id;
      db.query("INSERT INTO sessions (id, project_id, source_id, agent_runtime_type) VALUES ('existing', ?, ?, 'pi')").run(project.id, source);

      runMigrations(db);

      expect(db.query("SELECT id, background FROM sessions").all()).toEqual([{ id: "existing", background: 0 }]);
      expect(() => db.query("INSERT INTO sessions (id, project_id, source_id, agent_runtime_type, background) VALUES ('bad', ?, ?, 'pi', 2)").run(project.id, source)).toThrow("CHECK constraint");
    } finally {
      resetDb();
    }
  });

  test("046 makes every existing session an agent session", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // As 045 left the schema: sessions without the column.
      db.exec(`DELETE FROM migrations WHERE name = '046_session_kinds';
        ALTER TABLE sessions DROP COLUMN kind;`);
      const project = createProject("Kinds", "/tmp/kinds-046");
      const source = defaultSource(project.id)!.id;
      db.query("INSERT INTO sessions (id, project_id, source_id, agent_runtime_type) VALUES ('existing', ?, ?, 'pi')").run(project.id, source);

      runMigrations(db);

      expect(db.query("SELECT id, kind FROM sessions").all()).toEqual([{ id: "existing", kind: "agent" }]);
    } finally {
      resetDb();
    }
  });

  test("048 and 049 keep a closed task closed by its closed_at, dropping its status and the unread activity of its sessions", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // As 047 left the schema: tasks with a status column and no close or run start times.
      db.exec(`DELETE FROM migrations WHERE name IN ('048_task_closed_at_and_run_started_at', '049_task_status_from_closed_at');
        ALTER TABLE tasks DROP COLUMN closed_at;
        ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'open';`);
      const project = createProject("Closed", "/tmp/closed-048");
      const source = defaultSource(project.id)!.id;
      db.query(`INSERT INTO tasks (id, project_id, title, branch_name, status, updated_at) VALUES
        (1, ?1, 'Open', 'task/open', 'open', '2026-01-01T00:00:00.000Z'),
        (2, ?1, 'Closed', 'task/closed', 'closed', '2026-01-02T00:00:00.000Z')`).run(project.id);
      db.query(`INSERT INTO sessions (id, project_id, source_id, task_id, activity_state) VALUES
        ('open-unread', ?1, ?2, 1, 'finished'),
        ('closed-unread', ?1, ?2, 2, 'finished')`).run(project.id, source);

      runMigrations(db);

      expect(getTask(1)).toMatchObject({ status: "open", closed_at: null });
      expect(getTask(2)).toMatchObject({ status: "closed", closed_at: "2026-01-02T00:00:00.000Z" });
      expect(db.query("SELECT name FROM pragma_table_info('tasks') WHERE name = 'status'").all()).toEqual([]);
      expect(db.query("SELECT id, activity_state FROM sessions ORDER BY id").all()).toEqual([
        { id: "closed-unread", activity_state: null },
        { id: "open-unread", activity_state: "finished" },
      ]);
    } finally {
      resetDb();
    }
  });

  test("051 keeps every existing node, none of them removed", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // As 050 left the schema: nodes without the column.
      db.exec(`DELETE FROM migrations WHERE name = '051_node_removed_at';
        ALTER TABLE nodes DROP COLUMN removed_at;
        INSERT INTO nodes (id, name, public_key, hostname, paired_at) VALUES ('laptop', 'Laptop', 'key', 'box', '2026-10-01T00:00:00.000Z');`);

      runMigrations(db);

      expect(db.query("SELECT id, removed_at FROM nodes ORDER BY id").all()).toEqual([
        { id: "internal", removed_at: null },
        { id: "laptop", removed_at: null },
      ]);
    } finally {
      resetDb();
    }
  });

  test("052 drops the command outbox with the commands still queued in it, and gives sessions their automatic resumes", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // As 051 left the schema: the outbox as 039 narrowed it, without the 041 provision index.
      db.exec(`DELETE FROM migrations WHERE name = '052_drop_node_command_outbox';
        ALTER TABLE sessions DROP COLUMN auto_resumes;
        CREATE TABLE node_command_outbox (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          command_json TEXT NOT NULL CHECK(json_valid(command_json)),
          state TEXT NOT NULL CHECK(state IN ('queued', 'dispatching', 'failed')),
          result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_node_command_outbox_state ON node_command_outbox(state, created_at);
        CREATE UNIQUE INDEX idx_node_command_client_id ON node_command_outbox(session_id, json_extract(command_json, '$.clientId'))
          WHERE json_extract(command_json, '$.clientId') IS NOT NULL;`);
      const project = createProject("Outbox", "/tmp/outbox-052");
      createSession("s", project.id, { sourceId: defaultSource(project.id)!.id, agentRuntimeType: "pi" });
      db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES ('c', 's', ?, 'queued')")
        .run(JSON.stringify({ op: "session.prompt", clientId: "c", content: [], sourceSessionId: null }));

      runMigrations(db);

      expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE '%node_command%'").all()).toEqual([]);
      expect(db.query("SELECT id, auto_resumes FROM sessions").all()).toEqual([{ id: "s", auto_resumes: null }]);
    } finally {
      resetDb();
    }
  });

  test("053 gives stored assistant messages without a usage a zero one, in entries and compactions' retained tails, and changes nothing else", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      db.exec("DELETE FROM migrations WHERE name = '053_zero_usage_on_legacy_assistant_messages'");
      const project = createProject("Usage", "/tmp/usage-053");
      createSession("s", project.id, { sourceId: defaultSource(project.id)!.id, agentRuntimeType: "pi" });
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const usage = { ...zero, input: 3, output: 4, totalTokens: 7 };
      const legacyAssistant = { role: "assistant", content: [{ type: "text", text: "Old" }], timestamp: 2 };
      const user = { role: "reinsInput", content: [{ type: "text", text: "Hi" }], reinsId: "r", metadata: {}, timestamp: 1 };
      // Stored as written, spacing and all, so an untouched row is the same bytes.
      const rows: Array<[role: string, json: string]> = [
        ["reinsInput", JSON.stringify({ type: "message", message: user, timestamp: 1 }, null, 1)],
        ["assistant", JSON.stringify({ type: "message", message: legacyAssistant, timestamp: 2 })],
        ["assistant", JSON.stringify({ type: "message", message: { ...legacyAssistant, stopReason: "stop", usage }, timestamp: 3 }, null, 1)],
        ["toolResult", JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "t", toolName: "bash", content: [], isError: false, timestamp: 4 }, timestamp: 4 }, null, 1)],
        ["compaction", JSON.stringify({ type: "compaction", summary: "Earlier", tokensBefore: 10, retainedTail: [user, legacyAssistant, { ...legacyAssistant, usage }], timestamp: 5 })],
        ["compaction", JSON.stringify({ type: "compaction", summary: "Later", tokensBefore: 10, retainedTail: [user, { ...legacyAssistant, usage }], timestamp: 6 }, null, 1)],
      ];
      const insert = db.query("INSERT INTO session_messages (session_id, seq, harness_id, role, message_json, created_at) VALUES ('s', ?, ?, ?, ?, ?)");
      rows.forEach(([role, json], index) => insert.run(index + 1, `e${index + 1}`, role, json, `2026-01-0${index + 1}T00:00:00.000Z`));
      const read = () => db.query<{ id: number; session_id: string; seq: number; parent_id: number | null; harness_id: string; role: string; message_json: string; created_at: string }, []>(
        "SELECT id, session_id, seq, parent_id, harness_id, role, message_json, created_at FROM session_messages ORDER BY seq").all();
      const before = read();

      runMigrations(db);

      const after = read();
      expect(after.map(({ message_json: _, ...row }) => row)).toEqual(before.map(({ message_json: _, ...row }) => row));
      expect([0, 2, 3, 5].map(index => after[index]!.message_json)).toEqual([0, 2, 3, 5].map(index => before[index]!.message_json));
      expect(JSON.parse(after[1]!.message_json)).toEqual({ type: "message", message: { ...legacyAssistant, usage: zero }, timestamp: 2 });
      expect(JSON.parse(after[4]!.message_json)).toEqual({ ...JSON.parse(before[4]!.message_json), retainedTail: [user, { ...legacyAssistant, usage: zero }, { ...legacyAssistant, usage }] });

      db.exec("DELETE FROM migrations WHERE name = '053_zero_usage_on_legacy_assistant_messages'");
      runMigrations(db);
      expect(read()).toEqual(after);
    } finally {
      resetDb();
    }
  });

  test("055 drops the last applied settlement's ID and keeps every session's settlement", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // As 054 left the schema.
      db.exec(`DELETE FROM migrations WHERE name = '055_drop_settlement_replay';
        ALTER TABLE sessions ADD COLUMN last_settlement_id TEXT;`);
      const project = createProject("Settlements", "/tmp/settlements-055");
      createSession("s", project.id, { sourceId: defaultSource(project.id)!.id, agentRuntimeType: "pi" });
      db.exec(`UPDATE sessions SET settlement_json = '{"status":"completed"}', last_settlement_id = 'report-2' WHERE id = 's'`);

      runMigrations(db);

      expect(db.query("SELECT id, settlement_json FROM sessions").all()).toEqual([{ id: "s", settlement_json: '{"status":"completed"}' }]);
      const columns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('sessions')").all().map(column => column.name);
      expect(columns).not.toContain("last_settlement_id");
    } finally {
      resetDb();
    }
  });

  test("056 names each recorded run end's Pi operation from the session's lane (Reins' give-up of an operation still in progress, else Pi's last) and indexes the lanes with work", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // As 055 left the schema.
      db.exec(`DELETE FROM migrations WHERE name = '056_settlement_operation_ids'; DROP INDEX idx_pi_lane_pending;`);
      const project = createProject("Settlements", "/tmp/settlements-056");
      const sessions: Array<[id: string, activity: string | null, settlement: unknown, lane: unknown]> = [
        ["ended", "finished", { status: "completed" }, { currentOperationId: null, lastOperationId: "op-2", inbox: [] }],
        ["given-up", "finished", { status: "failed", error: { message: "The run was interrupted: the server restarted" } }, { currentOperationId: "op-3", lastOperationId: "op-2", inbox: [] }],
        ["running", "running", { status: "failed", error: { message: "x" } }, { currentOperationId: "op-5", lastOperationId: "op-4", inbox: [] }],
        ["after-run", null, { status: "completed" }, { currentOperationId: "op-7", lastOperationId: "op-6", inbox: [] }],
        ["never-ran", null, null, { currentOperationId: null, lastOperationId: null, inbox: [] }],
        ["no-lane", "finished", { status: "completed" }, null],
        ["recorded", "finished", { operationId: "op-9", source: "reins", status: "failed" }, { currentOperationId: null, lastOperationId: "op-9", inbox: [] }],
      ];
      for (const [id, activity, settlement, lane] of sessions) {
        createSession(id, project.id, { sourceId: defaultSource(project.id)!.id, agentRuntimeType: "pi" });
        db.query("UPDATE sessions SET activity_state = ?, settlement_json = ? WHERE id = ?").run(activity, settlement === null ? null : JSON.stringify(settlement), id);
        if (lane) db.query("INSERT INTO pi_values (session_id, namespace, key, seq, value_json) VALUES (?, 'pi.lane.state', 'main', 1, ?)").run(id, JSON.stringify(lane));
      }

      runMigrations(db);

      const records = Object.fromEntries(db.query<{ id: string; settlement_json: string | null }, []>("SELECT id, settlement_json FROM sessions").all()
        .map(row => [row.id, row.settlement_json === null ? null : JSON.parse(row.settlement_json)]));
      expect(records).toEqual({
        "ended": { status: "completed", operationId: "op-2", source: "pi" },
        "given-up": { status: "failed", error: { message: "The run was interrupted: the server restarted" }, operationId: "op-3", source: "reins" },
        // Running when its process exited, or a run in progress: its last end was Pi's.
        "running": { status: "failed", error: { message: "x" }, operationId: "op-4", source: "pi" },
        "after-run": { status: "completed", operationId: "op-6", source: "pi" },
        "never-ran": null,
        "no-lane": { status: "completed" },
        "recorded": { operationId: "op-9", source: "reins", status: "failed" },
      });
      // Recovery's scan of pending lanes repeats the index's WHERE, and SQLite uses it.
      const plan = db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN SELECT session_id FROM pi_values WHERE namespace = 'pi.lane.state' AND key = 'main'
        AND (json_extract(value_json, '$.currentOperationId') IS NOT NULL OR json_array_length(value_json, '$.inbox') > 0)`).all();
      expect(plan.map(row => row.detail).join("\n")).toContain("idx_pi_lane_pending");
    } finally {
      resetDb();
    }
  });

  test("057 drops the row's run copy and clears a leftover stored running, keeping the unread flag, the record and the resume budget", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // As 056 left the schema.
      db.exec(`DELETE FROM migrations WHERE name = '057_drop_session_run_copy';
        ALTER TABLE sessions ADD COLUMN run_id TEXT; ALTER TABLE sessions ADD COLUMN run_started_at TEXT;
        ALTER TABLE sessions ADD COLUMN settlement_count INTEGER NOT NULL DEFAULT 0; ALTER TABLE sessions ADD COLUMN settlement_next_seq INTEGER;`);
      const project = createProject("Runs", "/tmp/runs-057");
      const record = JSON.stringify({ operationId: "op-1", source: "pi", status: "completed" });
      for (const id of ["running", "unread", "quiet"]) createSession(id, project.id, { sourceId: defaultSource(project.id)!.id, agentRuntimeType: "pi" });
      db.query(`UPDATE sessions SET activity_state = 'running', run_id = 'op-2', run_started_at = '2026-10-18T00:00:00.000Z', settlement_count = 1,
        settlement_json = ?, settlement_next_seq = 4, auto_resumes = '[1]' WHERE id = 'running'`).run(record);
      db.query("UPDATE sessions SET activity_state = 'finished', settlement_count = 1, settlement_json = ? WHERE id = 'unread'").run(record);

      runMigrations(db);

      expect(db.query("SELECT id, activity_state, settlement_json, auto_resumes FROM sessions ORDER BY id").all()).toEqual([
        { id: "quiet", activity_state: null, settlement_json: null, auto_resumes: null },
        { id: "running", activity_state: null, settlement_json: record, auto_resumes: "[1]" },
        { id: "unread", activity_state: "finished", settlement_json: record, auto_resumes: null },
      ]);
      const columns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('sessions')").all().map(column => column.name);
      for (const dropped of ["run_id", "run_started_at", "settlement_count", "settlement_next_seq"]) expect(columns).not.toContain(dropped);
    } finally {
      resetDb();
    }
  });
});
