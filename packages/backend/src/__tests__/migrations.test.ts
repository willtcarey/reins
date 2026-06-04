import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runMigrations } from "../migrations.js";

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
});
