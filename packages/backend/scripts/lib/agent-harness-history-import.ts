import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const IMPORT_FORMAT_VERSION = 1;
export const DEFAULT_ACTIVE_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;

type ModelIdentity = { provider: string; modelId: string };
type SessionImportConfig = { model: ModelIdentity; activeToolNames?: string[] };
export type ImportConfig = {
  /** Exact identities exported from the installed Pi model catalog. */
  catalog: ModelIdentity[];
  sessions: Record<string, SessionImportConfig>;
};
export type ImportReport = {
  formatVersion: number;
  sourceSha256: string;
  sourceSidecars: { wal: boolean; shm: boolean };
  outputSha256: string;
  sessions: number;
  messages: number;
  attachments: number;
  roles: Record<string, number>;
  integrity: string;
  foreignKeys: number;
  unresolvedModels: { provider: string; modelId: string; sessions: number }[];
  unresolvedSettings: { key: string; provider: string; modelId: string }[];
  ancestryRepair: { changedLinks: number; affectedSessions: number };
};

type SessionRow = {
  id: string; model_provider: string | null; model_id: string | null;
  thinking_level: string | null; harness_next_seq: number;
};
type MessageRow = {
  id: number; session_id: string; seq: number; parent_id: number | null;
  harness_id: string | null; role: string; message_json: string; created_at: string;
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sqlString(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function assertDistinctFiles(source: string, output: string): void {
  const sourcePath = realpathSync(source);
  const outputPath = resolve(output);
  if (sourcePath === outputPath) throw new Error("Source and output must be distinct files");
  if (existsSync(outputPath)) {
    const outputRealPath = realpathSync(outputPath);
    if (outputRealPath === sourcePath) throw new Error("Source and output resolve to the same file");
    throw new Error(`Output already exists: ${outputPath}`);
  }
}

/** Create a WAL-aware SQLite snapshot. The source is opened read-only and is never modified. */
export function copyDatabaseWithVacuum(source: string, output: string): void {
  assertDistinctFiles(source, output);
  const db = new Database(source, { readonly: true });
  try { db.exec(`VACUUM INTO ${sqlString(resolve(output))}`); }
  finally { db.close(); }
}

function deterministicHarnessId(sessionId: string, rowId: number, logicalId: unknown): string {
  if (typeof logicalId === "string" && logicalId.length > 0) return logicalId;
  return `reins-import-v1-${createHash("sha256").update(`${sessionId}\0${rowId}`).digest("hex")}`;
}

function canonicalEnvelope(row: MessageRow, parsed: Record<string, unknown>, harnessId: string): Record<string, unknown> {
  const createdAt = Date.parse(row.created_at);
  if (!Number.isFinite(createdAt)) throw new Error(`Message ${row.id} has invalid created_at`);
  const timestamp = parsed.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new Error(`Message ${row.id} has invalid timestamp`);
  }
  if (parsed.metadata !== undefined && parsed.metadata !== null) {
    throw new Error(`Message ${row.id} contains unsupported metadata`);
  }
  if (row.role === "compactionSummary") {
    if (typeof parsed.summary !== "string") throw new Error(`Compaction message ${row.id} has no summary`);
    const tokensBefore = parsed.tokensBefore ?? 0;
    if (typeof tokensBefore !== "number" || !Number.isSafeInteger(tokensBefore) || tokensBefore < 0) {
      throw new Error(`Compaction message ${row.id} has invalid tokensBefore`);
    }
    return { timestamp, type: "compaction", summary: parsed.summary, retainedTail: [], tokensBefore, fromHook: false };
  }
  if (!["user", "assistant", "toolResult"].includes(row.role) || parsed.role !== row.role) {
    throw new Error(`Message ${row.id} has unsupported role/shape: ${row.role}`);
  }
  const { logicalId: _logicalId, ...message } = parsed;
  if (row.role === "user") {
    if (parsed.clientMessageId !== undefined && (typeof parsed.clientMessageId !== "string" || parsed.clientMessageId.length === 0)) {
      throw new Error(`User message ${row.id} has invalid clientMessageId`);
    }
    if (parsed.displayContent !== undefined && JSON.stringify(parsed.displayContent) !== JSON.stringify(parsed.content)) {
      throw new Error(`User message ${row.id} has displayContent that differs from content`);
    }
    return { timestamp, type: "message", message: {
      role: "reinsInput", content: parsed.content,
      reinsId: typeof parsed.clientMessageId === "string" ? parsed.clientMessageId : harnessId,
      metadata: {}, timestamp,
    } };
  }
  return { timestamp, type: "message", message: { ...message, timestamp } };
}

const PI_TABLE_COLUMNS: Record<string, string[]> = {
  pi_values: ["session_id", "namespace", "key", "seq", "value_json"],
  pi_lists: ["session_id", "namespace", "key", "seq", "value_json"],
  pi_usage: ["session_id", "id", "seq", "entry_id", "adjustment", "usage_json", "details_json"],
};

function validateCanonicalPiTables(db: Database): void {
  for (const [table, expected] of Object.entries(PI_TABLE_COLUMNS)) {
    const exists = db.query<{ ok: number }, [string]>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?) AS ok").get(table)?.ok === 1;
    if (!exists) throw new Error(`Canonical output is missing required table: ${table}`);
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (JSON.stringify(columns) !== JSON.stringify(expected)) throw new Error(`Canonical table ${table} has an unexpected column shape`);
  }
  const valuePk = db.query<{ name: string; pk: number }, []>("PRAGMA table_info(pi_values)").all().filter((row) => row.pk > 0).toSorted((a, b) => a.pk - b.pk).map((row) => row.name);
  const listPk = db.query<{ name: string; pk: number }, []>("PRAGMA table_info(pi_lists)").all().filter((row) => row.pk > 0).toSorted((a, b) => a.pk - b.pk).map((row) => row.name);
  const usageIndexes = db.query<{ unique: number }, []>("PRAGMA index_list(pi_usage)").all().filter((row) => row.unique === 1).length;
  if (valuePk.join(",") !== "session_id,namespace,key" || listPk.join(",") !== "session_id,namespace,key,seq" || usageIndexes < 2) {
    throw new Error("Canonical Pi table keys do not match the storage adapter contract");
  }
}

function validateSchema(db: Database): void {
  const migration = db.query<{ ok: number }, []>(
    "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='027_add_agent_harness_storage') AS ok",
  ).get();
  if (migration?.ok !== 1) throw new Error("Source schema must include 027_add_agent_harness_storage");
  for (const table of ["sessions", "session_messages", "session_attachments"]) {
    const row = db.query<{ ok: number }, [string]>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?) AS ok").get(table);
    if (row?.ok !== 1) throw new Error(`Source is missing required table: ${table}`);
  }
}

function validateSessionMapping(session: SessionRow, config: ImportConfig): SessionImportConfig {
  const selected = config.sessions[session.id];
  if (!selected?.model.provider?.trim() || !selected.model.modelId?.trim()) {
    throw new Error(`Session ${session.id} requires an explicit model {provider, modelId} mapping`);
  }
  if (!THINKING_LEVELS.has(session.thinking_level ?? "off")) {
    throw new Error(`Session ${session.id} has unsupported thinking level: ${session.thinking_level}`);
  }
  return selected;
}

function preflightSource(db: Database, config: ImportConfig): void {
  validateSchema(db);
  const sessions = db.query<SessionRow, []>("SELECT id,model_provider,model_id,thinking_level,harness_next_seq FROM sessions ORDER BY id").all();
  for (const session of sessions) validateSessionMapping(session, config);
  const metadata = db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM session_messages WHERE json_type(message_json,'$.metadata') IS NOT NULL AND json_type(message_json,'$.metadata') <> 'null'",
  ).get()!.count;
  if (metadata !== 0) throw new Error(`Source contains ${metadata} messages with unsupported metadata`);
  const malformed = db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM session_messages child
     LEFT JOIN session_messages parent ON parent.id=child.parent_id
     WHERE child.parent_id IS NOT NULL
       AND (parent.id IS NULL OR parent.session_id<>child.session_id OR parent.seq>=child.seq)`,
  ).get()!.count;
  if (malformed !== 0) throw new Error(`Source contains ${malformed} messages with invalid ancestry`);
  const alternativeParents = db.query<{ count: number }, []>(
    `WITH ordered AS (
       SELECT id,parent_id,LAG(id) OVER(PARTITION BY session_id ORDER BY seq,id) AS expected_parent
       FROM session_messages)
     SELECT COUNT(*) AS count FROM ordered
     WHERE parent_id IS NOT NULL AND parent_id IS NOT expected_parent`,
  ).get()!.count;
  if (alternativeParents !== 0) throw new Error(`Source contains ${alternativeParents} non-linear parent links; refusing to flatten possible branches`);
  for (const table of ["harness_values", "harness_list_values", "harness_usage"]) {
    const exists = db.query<{ ok: number }, [string]>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?) AS ok").get(table)?.ok === 1;
    if (!exists) continue;
    const count = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count;
    if (count !== 0) throw new Error(`Source contains ${count} rows in unsupported legacy table ${table}`);
  }
}

function migrateOutput(db: Database, config: ImportConfig): Omit<ImportReport, "sourceSha256" | "sourceSidecars" | "outputSha256"> {
  validateSchema(db);
  const targetTableCount = (table: string): number => {
    const exists = db.query<{ ok: number }, [string]>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?) AS ok").get(table)?.ok === 1;
    return exists ? db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count : 0;
  };
  const existing = db.query<{ count: number }, []>(
    `SELECT (SELECT COUNT(*) FROM session_messages WHERE harness_id IS NOT NULL)
      + (SELECT COUNT(*) FROM sessions WHERE harness_next_seq <> 1) AS count`,
  ).get()!.count + targetTableCount("pi_values") + targetTableCount("pi_lists") + targetTableCount("pi_usage");
  if (existing !== 0) throw new Error("Output is already or partially AgentHarness-canonical");

  const sessions = db.query<SessionRow, []>("SELECT id,model_provider,model_id,thinking_level,harness_next_seq FROM sessions ORDER BY id").all();
  const catalog = new Set(config.catalog.map((model) => `${model.provider}\0${model.modelId}`));
  const unresolvedCounts = new Map<string, { provider: string; modelId: string; sessions: number }>();
  const unresolvedSettings: { key: string; provider: string; modelId: string }[] = [];
  const messages = db.query<MessageRow, []>("SELECT id,session_id,seq,parent_id,harness_id,role,message_json,created_at FROM session_messages ORDER BY session_id,seq,id").all();
  const ids = new Map(messages.map((row) => [row.id, row]));
  const parsedByRow = new Map<number, Record<string, unknown>>();
  const logicalIdCounts = new Map<string, number>();
  for (const row of messages) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(row.message_json); } catch { throw new Error(`Message ${row.id} contains invalid JSON`); }
    parsedByRow.set(row.id, parsed);
    if (typeof parsed.logicalId === "string" && parsed.logicalId.length > 0) {
      const key = `${row.session_id}\0${parsed.logicalId}`;
      logicalIdCounts.set(key, (logicalIdCounts.get(key) ?? 0) + 1);
    }
  }
  const harnessIdByRow = new Map(messages.map((row) => {
    const logicalId = parsedByRow.get(row.id)!.logicalId;
    const uniqueLogicalId = typeof logicalId === "string" && logicalId.length > 0
      && logicalIdCounts.get(`${row.session_id}\0${logicalId}`) === 1 ? logicalId : undefined;
    return [row.id, deterministicHarnessId(row.session_id, row.id, uniqueLogicalId)] as const;
  }));
  const messagesBySession = new Map<string, MessageRow[]>();
  for (const message of messages) {
    const rows = messagesBySession.get(message.session_id) ?? [];
    rows.push(message);
    messagesBySession.set(message.session_id, rows);
  }
  const harnessIds = new Set<string>();
  const roles: Record<string, number> = {};
  let changedLinks = 0;
  const repairedSessions = new Set<string>();

  db.transaction(() => {
    // Empty provisional tables carry no state. Recreate them so similarly named but
    // under-constrained tables cannot masquerade as the canonical adapter schema.
    db.exec(`DROP TABLE IF EXISTS pi_usage;
    DROP TABLE IF EXISTS pi_lists;
    DROP TABLE IF EXISTS pi_values;
    CREATE TABLE pi_values (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL,
      value_json TEXT NOT NULL CHECK(json_valid(value_json)), PRIMARY KEY(session_id,namespace,key));
    CREATE TABLE pi_lists (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL,
      value_json TEXT NOT NULL CHECK(json_valid(value_json)), PRIMARY KEY(session_id,namespace,key,seq));
    CREATE TABLE pi_usage (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL, seq INTEGER NOT NULL, entry_id TEXT, adjustment INTEGER NOT NULL,
      usage_json TEXT NOT NULL CHECK(json_valid(usage_json)), details_json TEXT CHECK(details_json IS NULL OR json_valid(details_json)),
      PRIMARY KEY(session_id,id), UNIQUE(session_id,seq));`);
    validateCanonicalPiTables(db);
    const hasSettings = db.query<{ ok: number }, []>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings') AS ok").get()?.ok === 1;
    if (hasSettings) {
      const rows = db.query<{ key: string; value: string }, []>("SELECT key,value FROM settings WHERE key IN ('default_model','utility_model') ORDER BY key").all();
      for (const row of rows) {
        const setting: { provider?: unknown; modelId?: unknown; runtimeType?: unknown } = JSON.parse(row.value);
        if (typeof setting.provider !== "string" || !setting.provider || typeof setting.modelId !== "string" || !setting.modelId) {
          throw new Error(`Setting ${row.key} has an invalid model identity`);
        }
        const provider = setting.provider === "claude_agent_sdk" || setting.provider === "claude-agent-sdk" ? "anthropic" : setting.provider;
        const normalized = { ...setting, provider, runtimeType: "pi" };
        db.query("UPDATE settings SET value=? WHERE key=?").run(JSON.stringify(normalized), row.key);
        if (!catalog.has(`${provider}\0${setting.modelId}`)) unresolvedSettings.push({ key: row.key, provider, modelId: setting.modelId });
      }
    }
    for (const session of sessions) {
      const selected = validateSessionMapping(session, config);
      const modelKey = `${selected.model.provider}\0${selected.model.modelId}`;
      if (!catalog.has(modelKey)) {
        const unresolved = unresolvedCounts.get(modelKey) ?? { ...selected.model, sessions: 0 };
        unresolved.sessions++;
        unresolvedCounts.set(modelKey, unresolved);
      }
      const tools = selected.activeToolNames ?? [...DEFAULT_ACTIVE_TOOL_NAMES];
      if (tools.some((tool) => typeof tool !== "string" || tool.length === 0)) {
        throw new Error(`Session ${session.id} has invalid activeToolNames`);
      }
      const sessionRows = messagesBySession.get(session.id) ?? [];
      let expectedParent: number | null = null;
      for (const row of sessionRows) {
        if (row.parent_id === null && expectedParent !== null) {
          db.query("UPDATE session_messages SET parent_id=? WHERE id=?").run(expectedParent, row.id);
          changedLinks++;
          repairedSessions.add(session.id);
        }
        expectedParent = row.id;
        if (row.parent_id !== null) {
          const parent = ids.get(row.parent_id);
          if (!parent || parent.session_id !== row.session_id || parent.seq >= row.seq) {
            throw new Error(`Message ${row.id} has invalid ancestry`);
          }
        }
        const parsed = parsedByRow.get(row.id)!;
        const harnessId = harnessIdByRow.get(row.id)!;
        if (harnessIds.has(`${row.session_id}\0${harnessId}`)) throw new Error(`Session ${row.session_id} has duplicate logical identity: ${harnessId}`);
        harnessIds.add(`${row.session_id}\0${harnessId}`);
        const envelope = canonicalEnvelope(row, parsed, harnessId);
        const canonicalRole = row.role === "user" ? "reinsInput" : row.role === "compactionSummary" ? "compaction" : row.role;
        db.query("UPDATE session_messages SET harness_id=?, role=?, message_json=? WHERE id=?")
          .run(harnessId, canonicalRole, JSON.stringify(envelope), row.id);
        roles[row.role] = (roles[row.role] ?? 0) + 1;
      }
      const tip = sessionRows.at(-1);
      let seq = sessionRows.reduce((maximum, row) => Math.max(maximum, row.seq), 0) + 1;
      const values: [string, string, unknown][] = [
        ["pi.branch.tip", "main", tip ? harnessIdByRow.get(tip.id)! : null],
        ["pi.lane.config", "main", { model: selected.model, thinkingLevel: session.thinking_level ?? "off", activeToolNames: tools }],
        ["pi.lane.state", "main", { currentOperationId: null, lastOperationId: null, inbox: [] }],
      ];
      for (const [namespace, key, value] of values) {
        db.query("INSERT INTO pi_values(session_id,namespace,key,seq,value_json) VALUES(?,?,?,?,?)")
          .run(session.id, namespace, key, seq++, JSON.stringify(value));
      }
      db.query("UPDATE sessions SET harness_next_seq=?, agent_runtime_type='pi', model_provider=?, model_id=? WHERE id=?")
        .run(seq, selected.model.provider, selected.model.modelId, session.id);
    }
  })();

  const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()!.integrity_check;
  const foreignKeys = db.query("PRAGMA foreign_key_check").all().length;
  if (integrity !== "ok" || foreignKeys !== 0) throw new Error(`Post-import SQLite validation failed: integrity=${integrity}, foreignKeys=${foreignKeys}`);
  const attachments = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_attachments").get()!.count;
  return {
    formatVersion: IMPORT_FORMAT_VERSION, sessions: sessions.length, messages: messages.length,
    attachments, roles, integrity, foreignKeys,
    unresolvedModels: [...unresolvedCounts.values()].toSorted((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId)),
    unresolvedSettings,
    ancestryRepair: { changedLinks, affectedSessions: repairedSessions.size },
  };
}

export async function importAgentHarnessHistory(options: { source: string; output: string; config: ImportConfig; report?: string }): Promise<ImportReport> {
  assertDistinctFiles(options.source, options.output);
  const sourceBefore = await sha256File(options.source);
  const sourceSidecars = { wal: existsSync(`${options.source}-wal`), shm: existsSync(`${options.source}-shm`) };
  const sourceDb = new Database(options.source, { readonly: true });
  try { preflightSource(sourceDb, options.config); }
  finally { sourceDb.close(); }
  try {
    copyDatabaseWithVacuum(options.source, options.output);
    const db = new Database(options.output);
    let partial;
    try { db.exec("PRAGMA foreign_keys=ON"); partial = migrateOutput(db, options.config); }
    finally { db.close(); }
    const sourceAfter = await sha256File(options.source);
    if (sourceBefore !== sourceAfter) throw new Error("Source database changed during import");
    const report = {
      ...partial,
      sourceSha256: sourceBefore,
      sourceSidecars,
      outputSha256: await sha256File(options.output),
    };
    if (options.report) {
      if (existsSync(options.report)) throw new Error(`Report already exists: ${options.report}`);
      await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    }
    return report;
  } catch (error) {
    // The path was proven absent before copying. Remove only the artifact created by this invocation.
    await rm(options.output, { force: true });
    throw error;
  }
}
