import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, createReadStream, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, statfsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runMigrations } from "./migrations.js";

export interface CatalogIdentity { provider: string; modelId: string }

export interface StartupHistoryUpgradeOptions {
  dataDir?: string;
  allowVolatilePaths?: boolean;
  catalog?: readonly CatalogIdentity[];
  findOpenHandles?: (paths: string[]) => Promise<string>;
  failAt?: "after-backup" | "after-migrations" | "before-commit";
  onBackupSync?: (path: string) => void;
}

export type StartupHistoryStatus = "fresh" | "canonical" | "upgraded";

const LOCK_NAME = ".agent-harness-history-upgrade.lock";
const BACKUP_DIR = ".agent-harness-history-backups";
const RECOVERY_NAME = ".agent-harness-history-recovery.json";
let processLock: { fd: number; path: string; dev: number; ino: number } | undefined;

export function releaseStartupHistoryLock(): void {
  if (!processLock) return;
  closeSync(processLock.fd);
  if (existsSync(processLock.path)) {
    const current = lstatSync(processLock.path);
    if (current.dev === processLock.dev && current.ino === processLock.ino) unlinkSync(processLock.path);
  }
  processLock = undefined;
}

function tableExists(db: Database, name: string): boolean {
  return db.query<{ present: number }, [string]>("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
}

function isCanonicalDatabase(db: Database): boolean {
  if (!["sessions", "session_messages", "pi_values", "pi_lists", "pi_usage"].every((name) => tableExists(db, name))) return false;
  const sessionColumns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(sessions)").all().map((row) => row.name));
  const messageColumns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(session_messages)").all().map((row) => row.name));
  if (!sessionColumns.has("harness_next_seq") || !messageColumns.has("harness_id") || !messageColumns.has("parent_id")) return false;
  const harnessIndex = db.query<{ name: string; unique: number; partial: number }, []>("PRAGMA index_list(session_messages)").all()
    .find((index) => index.name === "idx_session_messages_session_harness_id");
  if (!harnessIndex || harnessIndex.unique !== 1 || harnessIndex.partial !== 1) return false;
  const messageFks = db.query<{ from: string; table: string }, []>("PRAGMA foreign_key_list(session_messages)").all();
  if (!messageFks.some((fk) => fk.from === "session_id" && fk.table === "sessions") ||
      !messageFks.some((fk) => fk.from === "parent_id" && fk.table === "session_messages")) return false;
  for (const table of ["pi_values", "pi_lists", "pi_usage"]) {
    const sql = db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql ?? "";
    if (!sql.includes("PRIMARY KEY") || !sql.includes("json_valid")) return false;
  }
  const invalid = db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM session_messages
     WHERE harness_id IS NULL OR json_extract(message_json, '$.type') NOT IN ('message','compaction','branchSummary','custom')
        OR role != CASE json_extract(message_json, '$.type')
          WHEN 'message' THEN json_extract(message_json, '$.message.role')
          ELSE json_extract(message_json, '$.type') END`,
  ).get()!.count;
  if (invalid !== 0 || db.query("PRAGMA foreign_key_check").all().length !== 0) return false;
  const duplicateIds = db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM (SELECT session_id,harness_id FROM session_messages GROUP BY session_id,harness_id HAVING COUNT(*)>1)",
  ).get()!.count;
  if (duplicateIds !== 0) return false;
  const invalidParents = db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM session_messages child JOIN session_messages parent ON parent.id=child.parent_id
     WHERE child.session_id!=parent.session_id OR parent.seq>=child.seq`,
  ).get()!.count;
  if (invalidParents !== 0) return false;
  const invalidNextSeq = db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM sessions s WHERE s.harness_next_seq <= COALESCE((
       SELECT MAX(seq) FROM (
         SELECT seq FROM session_messages WHERE session_id=s.id
         UNION ALL SELECT seq FROM pi_values WHERE session_id=s.id
         UNION ALL SELECT seq FROM pi_lists WHERE session_id=s.id
         UNION ALL SELECT seq FROM pi_usage WHERE session_id=s.id
       )
     ),0)`,
  ).get()!.count;
  if (invalidNextSeq !== 0) return false;
  for (const provisional of ["harness_values", "harness_list_values", "harness_usage"]) {
    if (tableExists(db, provisional) && db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${provisional}`).get()!.count !== 0) return false;
  }
  const sessions = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions").get()!.count;
  for (const namespace of ["pi.branch.tip", "pi.lane.config", "pi.lane.state"]) {
    const count = db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM pi_values WHERE namespace=? AND key='main'",
    ).get(namespace)!.count;
    if (count !== sessions) return false;
  }
  const invalidTips = db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM pi_values tip
     LEFT JOIN session_messages message ON message.session_id=tip.session_id AND message.harness_id=json_extract(tip.value_json,'$')
     WHERE tip.namespace='pi.branch.tip' AND tip.key='main'
       AND json_extract(tip.value_json,'$') IS NOT NULL AND message.id IS NULL`,
  ).get()!.count;
  return invalidTips === 0 && db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check === "ok";
}

function inspectExistingDatabase(path: string): "canonical" | "legacy" {
  const db = new Database(path, { readonly: true });
  try {
    if (db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
      throw new Error("Database integrity check failed before backup");
    }
    if (isCanonicalDatabase(db)) return "canonical";
    if (!["migrations", "projects", "sessions", "session_messages"].every((name) => tableExists(db, name))) {
      throw new Error("Database is not a recognized released Reins schema");
    }
    return "legacy";
  } finally { db.close(); }
}

async function lsofHandles(paths: string[]): Promise<string> {
  const existing = paths.filter(existsSync);
  if (existing.length === 0) return "";
  const executable = Bun.which("lsof");
  if (!executable) throw new Error("Automatic history upgrade requires lsof to detect existing database users");
  const child = Bun.spawn([executable, "-Fpcn", "--", ...existing], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0 && code !== 1) throw new Error(`lsof failed with exit code ${code}`);
  return output.trim();
}

function assertDurableCapacity(dataDir: string, dbPath: string): void {
  const resolved = resolve(dataDir);
  if (resolved.startsWith("/tmp/") || resolved === "/tmp" || resolved.startsWith("/dev/shm/") || resolved === "/dev/shm") {
    throw new Error(`Automatic history upgrade refuses volatile data directory: ${resolved}`);
  }
  const fs = statfsSync(dataDir, { bigint: true });
  const available = Number(fs.bavail) * Number(fs.bsize);
  const sourceBytes = statSync(dbPath).size + (["-wal", "-shm"] as const)
    .reduce((total, suffix) => total + (existsSync(`${dbPath}${suffix}`) ? statSync(`${dbPath}${suffix}`).size : 0), 0);
  // One immutable logical backup plus conservative live WAL/transaction overhead.
  const required = Math.ceil(sourceBytes * 2.5) + 256 * 1024 * 1024;
  if (available < required) throw new Error(`Insufficient free space for history upgrade: need ${required}, have ${available}`);
}

function acquireLock(path: string): number {
  try {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, `${process.pid}\n`);
    return fd;
  } catch (error) {
    throw new Error(`Backend startup lock exists at ${path}; another backend or interrupted startup requires operator review`, { cause: error });
  }
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeDurableJson(path: string, value: Record<string, unknown>): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  syncPath(temporary);
  renameSync(temporary, path);
  syncPath(dirname(path));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sqliteString(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function createLogicalSnapshot(source: string, output: string): void {
  if (existsSync(output)) throw new Error(`Snapshot path already exists: ${output}`);
  const db = new Database(source, { readonly: true });
  try { db.exec(`VACUUM INTO ${sqliteString(output)}`); }
  finally { db.close(); }
  chmodSync(output, 0o600);
  syncPath(output);
  syncPath(dirname(output));
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(/[-:.]/g, "");
}

function normalizeProvider(provider: string): string {
  return provider === "claude_agent_sdk" || provider === "claude-agent-sdk" ? "anthropic" : provider;
}

interface StartupImportConfig {
  catalog: CatalogIdentity[];
  sessions: Record<string, { model: CatalogIdentity }>;
}

function buildImportConfig(db: Database, catalog: readonly CatalogIdentity[]): StartupImportConfig {
  const sessions: StartupImportConfig["sessions"] = {};
  for (const row of db.query<{ id: string; model_provider: string | null; model_id: string | null }, []>(
    "SELECT id,model_provider,model_id FROM sessions ORDER BY id",
  ).all()) {
    if (!row.model_provider || !row.model_id) throw new Error(`Session ${row.id} has no explicit model identity`);
    sessions[row.id] = { model: { provider: normalizeProvider(row.model_provider), modelId: row.model_id } };
  }
  return { catalog: [...catalog], sessions };
}

/** Runs before getDb(), migrations through the application graph, handlers, watchers, or listeners. */
export async function prepareCanonicalHistoryBeforeStartup(
  options: StartupHistoryUpgradeOptions = {},
): Promise<StartupHistoryStatus> {
  const dataDir = resolve(options.dataDir ?? (process.env.REINS_DATA_DIR?.trim() || join(process.cwd(), ".reins")));
  const dbPath = join(dataDir, "reins.db");
  if (existsSync(dataDir) && lstatSync(dataDir).isSymbolicLink()) throw new Error(`REINS data directory must not be a symbolic link: ${dataDir}`);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, LOCK_NAME);
  const lockFd = acquireLock(lockPath);
  const lockStat = fstatSync(lockFd);
  processLock = { fd: lockFd, path: lockPath, dev: lockStat.dev, ino: lockStat.ino };
  const finish = <T extends StartupHistoryStatus>(status: T): T => {
    releaseStartupHistoryLock();
    return status;
  };
  const recoveryPath = join(dataDir, RECOVERY_NAME);
  if (existsSync(recoveryPath)) {
    releaseStartupHistoryLock();
    throw new Error(`Incomplete AgentHarness history upgrade recorded at ${recoveryPath}; inspect the immutable backup and recovery state before startup`);
  }
  if (!existsSync(dbPath) || statSync(dbPath).size === 0) return finish("fresh");
  if (lstatSync(dbPath).isSymbolicLink()) {
    releaseStartupHistoryLock();
    throw new Error(`REINS database path must not be a symbolic link: ${dbPath}`);
  }
  let classification: "canonical" | "legacy";
  try { classification = inspectExistingDatabase(dbPath); }
  catch (error) {
    releaseStartupHistoryLock();
    throw new Error(`Database format inspection failed before mutation: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (classification === "canonical") return finish("canonical");
  if (process.platform !== "linux") {
    releaseStartupHistoryLock();
    throw new Error("Automatic legacy history upgrade requires Linux handle inspection; stop writers and use a reviewed manual recovery path");
  }
  if (!options.allowVolatilePaths) {
    try { assertDurableCapacity(dataDir, dbPath); }
    catch (error) { releaseStartupHistoryLock(); throw error; }
  }

  const findHandles = options.findOpenHandles ?? lsofHandles;
  const livePaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const runDir = join(dataDir, BACKUP_DIR, timestamp());
  const backup = join(runDir, "pre-upgrade.sqlite");
  try {
    const open = await findHandles(livePaths);
    if (open) throw new Error(`Legacy database is open by another process; stop every backend before automatic upgrade (${open})`);
    mkdirSync(dirname(runDir), { recursive: true, mode: 0o700 });
    mkdirSync(runDir, { recursive: false, mode: 0o700 });
    createLogicalSnapshot(dbPath, backup);
    for (const path of [backup, runDir, dirname(runDir), dataDir]) {
      syncPath(path);
      options.onBackupSync?.(path);
    }
    const backupHash = await sha256File(backup);
    const backupDb = new Database(backup, { readonly: true });
    try {
      if (backupDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Backup integrity check failed");
      if (backupDb.query("PRAGMA foreign_key_check").all().length !== 0) throw new Error("Backup foreign-key check failed");
    } finally { backupDb.close(); }
    const recovery = { phase: "backed-up", runDir, liveDatabase: dbPath, backup, backupHash };
    writeDurableJson(join(runDir, "STATE.json"), recovery);
    writeDurableJson(recoveryPath, recovery);
    if (options.failAt === "after-backup") throw new Error("Injected failure after backup");

    const db = new Database(dbPath);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
      runMigrations(db);
      writeDurableJson(join(runDir, "STATE.json"), { ...recovery, phase: "migrated" });
      writeDurableJson(recoveryPath, { ...recovery, phase: "migrated" });
      if (options.failAt === "after-migrations") throw new Error("Injected failure after migrations");

      const importModulePath = "../scripts/lib/agent-harness-history-import.js";
      const validationModulePath = "../scripts/lib/agent-harness-history-validation.js";
      const { convertLegacyAgentHarnessHistoryInPlace } = await import(importModulePath);
      const { captureLegacyHistoryBaseline, validateConvertedAgentHarnessHistory } = await import(validationModulePath);
      let conversion: unknown;
      let validation: unknown;
      db.transaction(() => {
        const baseline = captureLegacyHistoryBaseline(db);
        conversion = convertLegacyAgentHarnessHistoryInPlace(db, buildImportConfig(db, options.catalog ?? []), baseline);
        validation = validateConvertedAgentHarnessHistory(db, baseline);
        if (!isCanonicalDatabase(db)) throw new Error("Converted database failed canonical startup validation");
        if (options.failAt === "before-commit") throw new Error("Injected failure before commit");
      })();
      writeDurableJson(join(runDir, "STATE.json"), { ...recovery, phase: "completed", conversion, validation });
      writeFileSync(join(runDir, "SUCCESS"), "completed\n", { mode: 0o600, flag: "wx" });
      syncPath(join(runDir, "SUCCESS"));
      syncPath(runDir);
      unlinkSync(recoveryPath);
      syncPath(dataDir);
      return finish("upgraded");
    } finally { db.close(); }
  } catch (error) {
    releaseStartupHistoryLock();
    throw new Error(
      `Automatic AgentHarness history upgrade failed. The immutable pre-migration backup and recovery evidence were retained at ${runDir}. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
