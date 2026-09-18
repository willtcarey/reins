import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { prepareCanonicalHistoryBeforeStartup, releaseStartupHistoryLock } from "../startup-history-upgrade.js";

const catalog = [{ provider: "anthropic", modelId: "claude-old" }];
const migrationsThrough026 = [
  "001_create_projects", "002_add_base_branch", "003_create_sessions", "004_create_session_messages", "005_session_indexes",
  "006_create_tasks", "007_add_session_task_id", "008_add_task_status", "009_timestamps_utc_suffix",
  "010_rename_task_status_merged_to_closed", "011_add_task_base_commit", "012_add_parent_session_id",
  "013_remove_duplicate_compaction_markers", "014_create_settings", "015_create_auth_credentials",
  "016_add_session_agent_runtime_type", "017_rename_thinking_signature", "018_create_session_attachments",
  "019_add_session_attachment_dimensions", "020_canonicalize_message_content", "021_add_session_activity_state",
  "022_create_code_reviews", "023_unique_open_code_review_scope", "024_add_code_review_submission_receipt",
  "025_make_code_reviews_pending_only", "026_add_session_message_ancestry",
];
afterEach(() => releaseStartupHistoryLock());

async function legacyDir(options: { recorded027?: boolean; harnessColumn?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reins-startup-upgrade-"));
  const db = new Database(join(root, "reins.db"));
  const harnessColumn = options.harnessColumn ?? options.recorded027 ?? false;
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE migrations(name TEXT PRIMARY KEY,applied_at TEXT);
    CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,path TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,agent_runtime_type TEXT NOT NULL,model_provider TEXT,model_id TEXT,thinking_level TEXT${harnessColumn ? ",harness_next_seq INTEGER NOT NULL DEFAULT 1" : ""});
    CREATE TABLE session_messages(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),seq INTEGER NOT NULL,role TEXT NOT NULL,message_json TEXT NOT NULL,created_at TEXT NOT NULL,parent_id INTEGER REFERENCES session_messages(id) ON DELETE SET NULL,harness_id TEXT);
    CREATE UNIQUE INDEX idx_session_messages_session_harness_id ON session_messages(session_id,harness_id) WHERE harness_id IS NOT NULL;
    CREATE TABLE session_attachments(id TEXT PRIMARY KEY,session_id TEXT,kind TEXT,mime_type TEXT,filename TEXT,byte_size INTEGER,sha256 TEXT,data BLOB,created_at TEXT,pruned_at TEXT,width INTEGER,height INTEGER);
  `);
  for (const name of migrationsThrough026) db.query("INSERT INTO migrations(name) VALUES(?)").run(name);
  if (options.recorded027) db.query("INSERT INTO migrations(name) VALUES('027_add_agent_harness_storage')").run();
  db.query(`INSERT INTO sessions(id,agent_runtime_type,model_provider,model_id,thinking_level${harnessColumn ? ",harness_next_seq" : ""}) VALUES('legacy','claude_agent_sdk','claude_agent_sdk','claude-old','medium'${harnessColumn ? ",1" : ""})`).run();
  const timestamp = Date.parse("2026-01-01T00:00:00.000Z");
  db.query("INSERT INTO session_messages VALUES(1,'legacy',1,'user',?,'2026-01-01T00:00:00.000Z',NULL,NULL)")
    .run(JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }], timestamp }));
  db.close();
  return root;
}

const upgrade = (dataDir: string, failAt?: "after-backup" | "after-migrations" | "before-commit") =>
  prepareCanonicalHistoryBeforeStartup({
    dataDir, allowVolatilePaths: true, catalog, findOpenHandles: async () => "", failAt,
  });

async function backupPath(root: string): Promise<string> {
  const matches = await Array.fromAsync(new Bun.Glob(".agent-harness-history-backups/*/pre-upgrade.sqlite").scan({ cwd: root, dot: true }));
  expect(matches).toHaveLength(1);
  return join(root, matches[0]!);
}

function role(root: string): string | undefined {
  const db = new Database(join(root, "reins.db"), { readonly: true });
  try { return db.query<{ role: string }, []>("SELECT role FROM session_messages").get()?.role; }
  finally { db.close(); }
}

describe("startup AgentHarness history upgrade", () => {
  test("leaves a fresh install for ordinary application initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-startup-fresh-"));
    try { expect(await upgrade(root)).toBe("fresh"); }
    finally { await rm(root, { recursive: true, force: true }); }
  });

  test("releases the startup lock before returning to a fresh server", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-startup-lock-"));
    try {
      expect(await prepareCanonicalHistoryBeforeStartup({ dataDir: root })).toBe("fresh");
      expect(await Bun.file(join(root, ".agent-harness-history-upgrade.lock")).exists()).toBe(false);
      expect(await prepareCanonicalHistoryBeforeStartup({ dataDir: root })).toBe("fresh");
    } finally { releaseStartupHistoryLock(); await rm(root, { recursive: true, force: true }); }
  });

  test("backs up the original pre-027 schema before migrations and upgrades on ordinary startup", async () => {
    const root = await legacyDir();
    try {
      expect(await upgrade(root)).toBe("upgraded");
      expect(await upgrade(root)).toBe("canonical");
      expect(role(root)).toBe("reinsInput");
      const backup = await backupPath(root);
      expect((await lstat(backup)).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(backup))).mode & 0o777).toBe(0o700);
      const before = new Database(backup, { readonly: true });
      expect(before.query<{ count: number }, []>("SELECT COUNT(*) count FROM pragma_table_info('sessions') WHERE name='harness_next_seq'").get()?.count).toBe(0);
      before.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);

  test("converts a recorded-027 draft whose verified-empty Pi tables are missing", async () => {
    const root = await legacyDir({ recorded027: true });
    try {
      expect(await upgrade(root)).toBe("upgraded");
      const db = new Database(join(root, "reins.db"), { readonly: true });
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) count FROM pi_values").get()?.count).toBe(3);
      db.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);

  test("a failure after backup leaves the live schema and history byte-identical", async () => {
    const root = await legacyDir();
    const before = await readFile(join(root, "reins.db"));
    try {
      await expect(upgrade(root, "after-backup")).rejects.toThrow("immutable pre-migration backup");
      expect(await readFile(join(root, "reins.db"))).toEqual(before);
      expect(await readFile(join(root, ".agent-harness-history-recovery.json"), "utf8")).toContain("backed-up");
      await backupPath(root);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("fsyncs the snapshot and every new parent directory before schema mutation", async () => {
    const root = await legacyDir();
    const synced: string[] = [];
    try {
      await expect(prepareCanonicalHistoryBeforeStartup({
        dataDir: root, allowVolatilePaths: true, catalog, findOpenHandles: async () => "",
        failAt: "after-backup", onBackupSync: (path) => synced.push(path),
      })).rejects.toThrow("Injected failure after backup");
      const backup = await backupPath(root);
      expect(synced).toEqual([backup, dirname(backup), dirname(dirname(backup)), root]);
      const live = new Database(join(root, "reins.db"), { readonly: true });
      expect(live.query<{ count: number }, []>("SELECT COUNT(*) count FROM pragma_table_info('sessions') WHERE name='harness_next_seq'").get()?.count).toBe(0);
      live.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("a transactional failure rolls back history while retaining migrated schema and recovery evidence", async () => {
    const root = await legacyDir();
    try {
      await expect(upgrade(root, "before-commit")).rejects.toThrow("Injected failure before commit");
      expect(role(root)).toBe("user");
      const db = new Database(join(root, "reins.db"), { readonly: true });
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) count FROM pragma_table_info('sessions') WHERE name='harness_next_seq'").get()?.count).toBe(1);
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) count FROM pi_values").get()?.count).toBe(0);
      db.close();
      expect(await readFile(join(root, ".agent-harness-history-recovery.json"), "utf8")).toContain("migrated");
      await backupPath(root);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);

  test("a schema migration failure retains the immutable backup for explicit restoration", async () => {
    const root = await legacyDir({ harnessColumn: true });
    try {
      await expect(upgrade(root)).rejects.toThrow("immutable pre-migration backup");
      expect(role(root)).toBe("user");
      expect(await readFile(join(root, ".agent-harness-history-recovery.json"), "utf8")).toContain("backed-up");
      await backupPath(root);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects detected active users before creating a backup or mutating the database", async () => {
    const root = await legacyDir();
    const before = await readFile(join(root, "reins.db"));
    try {
      await expect(prepareCanonicalHistoryBeforeStartup({
        dataDir: root, allowVolatilePaths: true, catalog, findOpenHandles: async () => "p123\ncnode",
      })).rejects.toThrow("stop every backend");
      expect(await readFile(join(root, "reins.db"))).toEqual(before);
      expect(await Array.fromAsync(new Bun.Glob(".agent-harness-history-backups/*").scan({ cwd: root, dot: true }))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("fails closed on volatile storage before backup or mutation", async () => {
    const root = await legacyDir();
    try {
      await expect(prepareCanonicalHistoryBeforeStartup({ dataDir: root, catalog, findOpenHandles: async () => "" }))
        .rejects.toThrow("refuses volatile data directory");
      expect(role(root)).toBe("user");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
