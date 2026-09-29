/**
 * A session's run lifecycle as node reports leave it on the session row: the run in progress (`run_id`,
 * from its `session.started` until its `session.settled`) and the latest settlement (its outcome, a count
 * of settlements applied and the storage's `harness_next_seq` when it was applied), which
 * `sessions.wait` reads. Written inside the caller's transaction, with the report's other effects.
 */
import { getDb } from "./db.js";

export interface RunSettlement { status: "completed" | "failed" | "aborted"; error?: { code?: string; message: string } }
/** The latest settlement: `seq` counts applied settlements, so a caller can tell whether one arrived
 * after an earlier observation; `nextSeq` is the session's `harness_next_seq` when it was applied (its
 * run's commits reach the server before its settlement, so every entry below it was committed before). */
export interface LatestSettlement extends RunSettlement { seq: number; nextSeq: number }

/**
 * Records a `session.started` report; false when it is a repeat (Pi reports `started` again for the run
 * in progress on in-run compaction), which applies nothing. A start for a run that already settled
 * applies: Pi resumed it (after the server or the node settled it as interrupted or failed).
 */
export function recordRunStarted(sessionId: string, runId: string): boolean {
  return getDb().query("UPDATE sessions SET run_id = ?1 WHERE id = ?2 AND run_id IS NOT ?1").run(runId, sessionId).changes > 0;
}

/** Records a `session.settled` report: the run is no longer in progress and this is the latest settlement. */
export function recordRunSettled(sessionId: string, { status, error }: RunSettlement): void {
  getDb().query(`UPDATE sessions SET run_id = NULL, settlement_count = settlement_count + 1, settlement_json = ?,
    settlement_next_seq = harness_next_seq WHERE id = ?`).run(JSON.stringify({ status, ...(error ? { error } : {}) }), sessionId);
}

/** The run a `session.started` report started and no settlement has ended yet, or null. */
export function runInProgress(sessionId: string): string | null {
  return getDb().query<{ run_id: string | null }, [string]>("SELECT run_id FROM sessions WHERE id = ?").get(sessionId)?.run_id ?? null;
}

/** The session's latest settlement, or null before its first. */
export function latestSettlement(sessionId: string): LatestSettlement | null {
  const row = getDb().query<{ settlement_count: number; settlement_json: string | null; settlement_next_seq: number | null }, [string]>(
    "SELECT settlement_count, settlement_json, settlement_next_seq FROM sessions WHERE id = ?").get(sessionId);
  if (!row?.settlement_json) return null;
  const { status, error }: RunSettlement = JSON.parse(row.settlement_json);
  return { seq: row.settlement_count, nextSeq: row.settlement_next_seq ?? 0, status, ...(error ? { error } : {}) };
}
