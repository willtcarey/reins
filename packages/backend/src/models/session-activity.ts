/**
 * Whether a session is busy, read only from server projections: the session row's `activity_state`
 * (maintained from the node's lifecycle reports by `sessions/session-runs.ts`) and the command outbox.
 * Reading writes nothing.
 */
import { getDb } from "../db.js";
import { pendingInputs, sessionsWithPendingInput } from "../nodes/node-command-store.js";
import type { SessionRow } from "../session-store.js";

/**
 * Activity of a session, read only from server projections, never from a live node runtime:
 *
 * - `running`: `activity_state` is `running`, maintained by the node's `session.started` /
 *   `session.settled` reports.
 * - `queued`: prompt/steer input in the outbox is still queued or being delivered. It counts as active
 *   so a run whose `session.started` has not been delivered yet (or whose input the node has not
 *   admitted yet) is not mistaken for idle.
 * - `idle`: neither.
 *
 * Edge cases: an input the node has admitted (its command is deleted from the outbox) whose
 * `session.started` is still in flight reads `idle` for that short gap (`waitForSettlement` tracks the
 * inputs it observed and closes it from the session's storage). A run whose node never reconnects stays
 * `running`. Dispatches interrupted by a restart are requeued, so they stay pending work; failed inputs
 * are deleted, so they are not.
 */
export type SessionActivity = "running" | "queued" | "idle";

export function sessionActivity(row: Pick<SessionRow, "id" | "activity_state">): SessionActivity {
  if (row.activity_state === "running") return "running";
  return pendingInputs(row.id).length > 0 ? "queued" : "idle";
}

/** Sessions whose `sessionActivity` is not `idle`, including sessions whose input is queued behind their
 * move onto a node. */
export function activeSessionIds(): string[] {
  const running = getDb().query<{ id: string }, []>("SELECT id FROM sessions WHERE activity_state = 'running'").all().map(row => row.id);
  return [...new Set([...running, ...sessionsWithPendingInput()])];
}
