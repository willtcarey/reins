import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

function tableExists(db: Database, name: string): boolean {
  return db.query<{ present: number }, [string]>("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
}

/** Read-only structural check. Legacy messages are never converted on startup. */
export function isCanonicalDatabase(db: Database): boolean {
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
  // A node-owned session may be persisted before its lane has been provisioned.
  const emptyNodeSessions = sessionColumns.has("storage_owner") ? db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM sessions s
    WHERE s.storage_owner = 'internal-node' AND s.harness_next_seq = 1
      AND NOT EXISTS (SELECT 1 FROM session_messages WHERE session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM pi_values WHERE session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM pi_lists WHERE session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM pi_usage WHERE session_id = s.id)
  `).get()!.count : 0;
  for (const namespace of ["pi.branch.tip", "pi.lane.config", "pi.lane.state"]) {
    const count = db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM pi_values WHERE namespace=? AND key='main'",
    ).get(namespace)!.count;
    if (count !== sessions - emptyNodeSessions) return false;
  }
  const invalidTips = db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM pi_values tip
     LEFT JOIN session_messages message ON message.session_id=tip.session_id AND message.harness_id=json_extract(tip.value_json,'$')
     WHERE tip.namespace='pi.branch.tip' AND tip.key='main'
       AND json_extract(tip.value_json,'$') IS NOT NULL AND message.id IS NULL`,
  ).get()!.count;
  return invalidTips === 0 && db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check === "ok";
}

/** Fail before application bootstrap or schema migrations can change unsupported history. */
export function assertCanonicalHistoryBeforeStartup(dataDir: string): "fresh" | "canonical" {
  const path = join(dataDir, "reins.db");
  if (!existsSync(path)) return "fresh";
  const db = new Database(path, { readonly: true });
  try {
    if (!isCanonicalDatabase(db)) {
      throw new Error(`Unsupported Reins history format at ${path}. No automatic conversion is available; restore a canonical AgentHarness database before starting.`);
    }
    return "canonical";
  } finally { db.close(); }
}
