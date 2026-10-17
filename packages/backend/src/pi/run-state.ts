/**
 * Pi's run state, as its storage holds it: Reins' reads of a session's lane and operations without a live
 * runtime (docs/plans/session-run-state-from-pi.md). Pi's exported address helpers and types define the
 * format (its published storage contract, read here with SQL), so a Pi upgrade that changes it fails
 * typechecking here; pi-durable will replace this module.
 *
 * - The lane state (`pi.lane.state`): the operation in progress (`currentOperationId`, set from its accept
 *   to its terminal commit), the last one that ended and the queued inputs.
 * - An operation's meta (`pi.op.meta`), while it is in progress: its kind and when it started.
 * - An operation's result (`pi.result`), written by its terminal commit and never deleted.
 *
 * Pi's storage cannot tell an operation being driven from one an exit cut off: only the process knows.
 */
import type { Database } from "bun:sqlite";
import { laneState, operationMeta, type LaneState, type OperationMeta, type Value } from "@earendil-works/pi-agent-core";
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
  return readValue(db, sessionId, laneState(MAIN_LANE));
}

/** The operation in progress on the session's main lane (being driven, or cut off by an exit), or null. */
export function readPendingPiOperation(db: Database, sessionId: string): PendingPiOperation | null {
  const operationId = readLaneState(db, sessionId)?.currentOperationId;
  if (!operationId) return null;
  const meta = readValue(db, sessionId, operationMeta(operationId));
  return meta ? { operationId, kind: meta.intent.kind, startedAt: meta.startedAt } : null;
}
