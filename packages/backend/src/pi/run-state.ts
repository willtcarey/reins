/**
 * Pi's run state, as its storage holds it: Reins' reads of a session's lane and operations without a live
 * runtime (docs/plans/session-run-state-from-pi.md). Pi's exported address helpers and types define the
 * format (its published storage contract, read here with SQL), so a Pi upgrade that changes it fails
 * typechecking here; pi-durable will replace this module.
 *
 * - The lane state (`pi.lane.state`): the operation in progress (`currentOperationId`, set from its accept
 *   to its terminal commit), the last one that ended and the queued inputs. Lanes with work are indexed
 *   (`idx_pi_lane_pending`, migration 056).
 * - An operation's meta (`pi.op.meta`), while it is in progress: its kind and when it started.
 * - An operation's result (`pi.result`), written by its terminal commit and never deleted.
 *
 * Pi's storage cannot tell an operation being driven from one an exit cut off: only the process knows.
 */
import type { Database } from "bun:sqlite";
import { laneState, operationMeta, operationResult, type LaneState, type OperationMeta, type OperationResultRecord, type Value } from "@earendil-works/pi-agent-core";
import { MAIN_LANE } from "../session-runtime/lane.js";

/** An operation in progress on a session's main lane, as Pi left it in storage. */
export interface PendingPiOperation {
  operationId: string;
  kind: OperationMeta["intent"]["kind"];
  /** When Pi accepted it (ms). */
  startedAt: number;
}

/** The value at `address` in the session's Pi storage, or null. */
function readValue<T>(db: Database, sessionId: string, address: Value<T>): T | null {
  const row = db.query<{ value_json: string }, [string, string, string]>(
    "SELECT value_json FROM pi_values WHERE session_id = ? AND namespace = ? AND key = ?",
  ).get(sessionId, address.namespace, address.key);
  if (!row) return null;
  const value: T = JSON.parse(row.value_json);
  return value;
}

/** The session's main lane state, or null before Pi created the lane. */
function readLaneState(db: Database, sessionId: string): LaneState | null {
  return readValue(db, sessionId, MAIN_LANE_STATE);
}

const MAIN_LANE_STATE = laneState(MAIN_LANE);
/** The WHERE of `idx_pi_lane_pending` (migration 056): main lanes with an operation in progress or queued
 * inputs. A query must repeat it exactly for SQLite to use the index. */
const LANES_WITH_WORK = `namespace = '${MAIN_LANE_STATE.namespace}' AND key = '${MAIN_LANE_STATE.key}'
  AND (json_extract(value_json, '$.currentOperationId') IS NOT NULL OR json_array_length(value_json, '$.inbox') > 0)`;

/** Every session with an operation in progress on its main lane (being driven, or cut off by an exit). */
export function pendingPiOperations(db: Database): Array<{ sessionId: string; operationId: string }> {
  return db.query<{ sessionId: string; operationId: string }, []>(
    `SELECT session_id AS sessionId, json_extract(value_json, '$.currentOperationId') AS operationId FROM pi_values
     WHERE ${LANES_WITH_WORK} AND json_extract(value_json, '$.currentOperationId') IS NOT NULL`,
  ).all();
}

/** The operation in progress on the session's main lane (being driven, or cut off by an exit), or null. */
export function readPendingPiOperation(db: Database, sessionId: string): PendingPiOperation | null {
  const operationId = readLaneState(db, sessionId)?.currentOperationId;
  if (!operationId) return null;
  const meta = readValue(db, sessionId, operationMeta(operationId));
  return meta ? { operationId, kind: meta.intent.kind, startedAt: meta.startedAt } : null;
}

/** How operation `operationId` ended, as Pi committed it, or null while it has not. */
export function readOperationResult(db: Database, sessionId: string, operationId: string): OperationResultRecord | null {
  return readValue(db, sessionId, operationResult(operationId));
}

const RESULTS = operationResult("").namespace;

/** How the session's last run ended, as Pi committed it (its newest result of kind `run`, the last one
 * written: a standalone compaction or navigation is not a run), or null before its first run ended. */
export function readNewestRunResult(db: Database, sessionId: string): OperationResultRecord | null {
  const row = db.query<{ value_json: string }, [string, string]>(
    `SELECT value_json FROM pi_values WHERE session_id = ? AND namespace = ? AND json_extract(value_json, '$.kind') = 'run'
     ORDER BY seq DESC LIMIT 1`,
  ).get(sessionId, RESULTS);
  if (!row) return null;
  const result: OperationResultRecord = JSON.parse(row.value_json);
  return result;
}
