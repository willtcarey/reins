import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runMigrations } from "../migrations.js";
import { setDb, resetDb } from "../db.js";
import { createProject } from "../project-store.js";
import { createSession } from "../session-store.js";
import { internalSource } from "../node-store.js";

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
      const index = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_node_command_outbox_session_provision'").get();
      expect(index?.name).toBe("idx_node_command_outbox_session_provision");

      const project = createProject("Existing schema", "/tmp/existing-schema");
      const created = createSession("new-node-session", project.id, {
        sourceId: internalSource(project.id).id, agentRuntimeType: "pi", storageOwner: "internal-node",
      });
      expect(created.storage_owner).toBe("internal-node");
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
      createSession("s", project.id, { sourceId: internalSource(project.id).id, agentRuntimeType: "pi" });
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
  test("035 replaces the node receipt tables with per-session watermarks, keeping sessions and their sequence", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // Reconstruct the 034 schema: the ledger decides what runs.
      db.exec(`DROP TABLE node_session_watermarks; DELETE FROM migrations WHERE name = '035_node_session_watermarks';
        CREATE TABLE node_replica_receipts (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          start_seq INTEGER NOT NULL, writes_json TEXT NOT NULL, PRIMARY KEY(session_id, start_seq));
        CREATE TABLE node_lifecycle_receipts (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('started', 'settled')), payload_json TEXT NOT NULL,
          PRIMARY KEY(session_id, run_id, kind));`);
      const project = createProject("Receipts", "/tmp/receipts-035");
      createSession("s", project.id, { sourceId: internalSource(project.id).id, agentRuntimeType: "pi", storageOwner: "internal-node" });
      db.exec(`UPDATE sessions SET harness_next_seq = 7, activity_state = 'running' WHERE id = 's';
        INSERT INTO node_replica_receipts VALUES ('s', 1, '[]');
        INSERT INTO node_lifecycle_receipts VALUES ('s', 'r1', 'started', '{"runId":"r1"}')`);

      runMigrations(db);
      expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('node_replica_receipts', 'node_lifecycle_receipts')").all()).toEqual([]);
      expect(db.query("SELECT harness_next_seq, activity_state, storage_owner FROM sessions WHERE id = 's'").get())
        .toEqual({ harness_next_seq: 7, activity_state: "running", storage_owner: "internal-node" });
      // No backfill: watermarks start empty and are written as batches and reports are applied.
      expect(db.query("SELECT COUNT(*) n FROM node_session_watermarks").get()).toEqual({ n: 0 });
      db.exec("INSERT INTO node_session_watermarks(session_id, commit_start_seq, commit_sha256) VALUES ('s', 6, 'hash')");
      expect(() => db.exec("INSERT INTO node_session_watermarks(session_id, report_kind) VALUES ('missing', 'started')")).toThrow();
      expect(() => db.exec("UPDATE node_session_watermarks SET report_kind = 'other' WHERE session_id = 's'")).toThrow();
      db.exec("DELETE FROM sessions WHERE id = 's'");
      expect(db.query("SELECT COUNT(*) n FROM node_session_watermarks").get()).toEqual({ n: 0 });
    } finally {
      resetDb();
    }
  });

  test("036 sets each session's placement from its own row and pending work, and deletes settled outbox commands", () => {
    const db = new Database(":memory:");
    setDb(db);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      runMigrations(db);
      // Reconstruct the 035 schema: the ledger decides what runs.
      db.exec(`DELETE FROM migrations WHERE name = '036_session_placement_status';
        ALTER TABLE sessions DROP COLUMN placement_status; ALTER TABLE sessions DROP COLUMN status_error;
        ALTER TABLE node_session_watermarks DROP COLUMN settlement_next_seq;`);
      const project = createProject("Placement", "/tmp/placement-036");
      const source = internalSource(project.id).id;
      db.query("INSERT INTO nodes (id, name) VALUES ('other', 'Other')").run();
      const other = db.query<{ id: number }, [number]>("INSERT INTO sources (project_id, node_id, path) VALUES (?, 'other', '/elsewhere') RETURNING id").get(project.id)!.id;
      const session = (id: string, owner: "server" | "internal-node") =>
        db.query("INSERT INTO sessions (id, project_id, source_id, agent_runtime_type, storage_owner, harness_next_seq) VALUES (?, ?, ?, 'pi', ?, 9)").run(id, project.id, source, owner);
      const command = (id: string, sessionId: string, state: string, json: unknown, result: unknown = null) =>
        db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state, result_json) VALUES (?, ?, ?, ?, ?)")
          .run(id, sessionId, JSON.stringify(json), state, result === null ? null : JSON.stringify(result));
      const provision = { op: "session.provision", configuration: { model: null, thinkingLevel: null, task: null } };
      session("legacy", "server");
      session("owned", "internal-node");
      command("owned-provision", "owned", "admitted", provision, { ok: true, value: { kind: "provisioned" } });
      command("owned-input", "owned", "admitted", { op: "session.prompt", clientId: "a", content: [] }, { ok: true, value: { kind: "admitted", inputId: "a" } });
      command("owned-pending", "owned", "queued", { op: "session.prompt", clientId: "b", content: [] });
      session("provisioning", "internal-node");
      command("provisioning-provision", "provisioning", "queued", provision);
      session("moving", "server");
      command("moving-hydrate", "moving", "queued", { op: "session.hydrate", targetSourceId: other });
      session("interrupted", "internal-node");
      command("interrupted-provision", "interrupted", "unknown", provision);
      command("interrupted-input", "interrupted", "unknown", { op: "session.prompt", clientId: "c", content: [] });
      session("failed-move", "internal-node");
      command("failed-move-provision", "failed-move", "admitted", provision, { ok: true, value: { kind: "provisioned" } });
      command("failed-move-hydrate", "failed-move", "failed", { op: "session.hydrate", targetSourceId: source }, { ok: false, error: { code: "invalid_request", message: "digest mismatch", retryable: false } });
      db.exec(`INSERT INTO node_session_watermarks (session_id, settlement_count, settlement_json) VALUES ('owned', 2, '{"status":"completed"}');
        INSERT INTO node_session_watermarks (session_id, commit_start_seq) VALUES ('legacy', 3)`);

      runMigrations(db);
      expect(db.query("SELECT id, placement_status, status_error, source_id FROM sessions ORDER BY id").all()).toEqual([
        { id: "failed-move", placement_status: "move_failed", status_error: "digest mismatch", source_id: source },
        { id: "interrupted", placement_status: "provision_failed", status_error: "Interrupted by a server restart", source_id: source },
        { id: "legacy", placement_status: "server", status_error: null, source_id: source },
        { id: "moving", placement_status: "moving", status_error: null, source_id: other },
        { id: "owned", placement_status: "provisioned", status_error: null, source_id: source },
        { id: "provisioning", placement_status: "provisioning", status_error: null, source_id: source },
      ]);
      // Only pending work is kept: the outbox is a queue.
      expect(db.query("SELECT id, state FROM node_command_outbox ORDER BY id").all()).toEqual([
        { id: "moving-hydrate", state: "queued" }, { id: "owned-pending", state: "queued" }, { id: "provisioning-provision", state: "queued" },
      ]);
      expect(db.query("SELECT session_id, settlement_next_seq FROM node_session_watermarks ORDER BY session_id").all())
        .toEqual([{ session_id: "legacy", settlement_next_seq: null }, { session_id: "owned", settlement_next_seq: 9 }]);
      expect(() => db.exec("UPDATE sessions SET placement_status = 'open' WHERE id = 'owned'")).toThrow();
      // New sessions default from their owner.
      expect(createSession("fresh", project.id, { sourceId: source, agentRuntimeType: "pi", storageOwner: "internal-node" }).placement_status).toBe("provisioned");
      expect(createSession("fresh-legacy", project.id, { sourceId: source, agentRuntimeType: "pi" }).placement_status).toBe("server");
    } finally {
      resetDb();
    }
  });
});
