import type { SessionRow } from "../session-store.js";
import { hasPendingInput } from "../node-command-store.js";
import { getDb } from "../db.js";

/**
 * Activity of a node-owned session, read only from server projections, never from a live node
 * runtime (the node may run in another process):
 *
 * - `running`: `activity_state` is `running`, maintained by the node's durable `session.started` /
 *   `session.settled` reports.
 * - `queued`: prompt/steer input in `node_command_outbox` is still queued or being delivered. It
 *   counts as active so a run whose `session.started` has not been delivered yet (or whose input the
 *   node has not admitted yet) is not mistaken for idle.
 * - `idle`: neither.
 *
 * Edge cases: an input the node has admitted (its command is deleted from the outbox) whose
 * `session.started` is still in flight reads `idle` for that short gap (`SessionInstance.wait` tracks
 * the inputs it observed and closes it from the replica). A run that never settles because the node
 * died mid-run stays `running` until a later run settles. Dispatches interrupted by a restart and
 * failed inputs are deleted, so they are not pending work. Provision alone is not activity.
 */
export type NodeSessionActivity = "running" | "queued" | "idle";

export function nodeSessionActivity(row: Pick<SessionRow, "id" | "activity_state">): NodeSessionActivity {
  if (row.activity_state === "running") return "running";
  return hasPendingInput(row.id) ? "queued" : "idle";
}

/** Sessions whose `nodeSessionActivity` is not `idle`: node-owned sessions, and sessions at rest on the
 * server whose input is queued behind their move onto a node (SQL only preselects candidates). */
export function activeNodeSessionIds(): string[] {
  return getDb().query<Pick<SessionRow, "id" | "activity_state">, []>(`SELECT id, activity_state FROM sessions
    WHERE (storage_owner = 'internal-node' AND activity_state = 'running')
      OR id IN (SELECT session_id FROM node_command_outbox WHERE state IN ('queued', 'dispatching'))`).all()
    .filter(row => nodeSessionActivity(row) !== "idle").map(row => row.id);
}
