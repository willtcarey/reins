import type { SessionRow } from "../session-store.js";
import { hasPendingInput } from "../node-command-store.js";
import { getDb } from "../db.js";

/**
 * Activity of a session, read only from server projections, never from a live node runtime (the node
 * may run in another process; the server runs none):
 *
 * - `running`: `activity_state` is `running`, maintained by the node's durable `session.started` /
 *   `session.settled` reports. A session at rest on the server runs nowhere, so a `running` it kept
 *   from when the server still ran sessions is stale and ignored.
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

export function nodeSessionActivity(row: Pick<SessionRow, "id" | "activity_state" | "placement_status">): NodeSessionActivity {
  if (row.activity_state === "running" && row.placement_status !== "server") return "running";
  return hasPendingInput(row.id) ? "queued" : "idle";
}

/** Sessions whose `nodeSessionActivity` is not `idle`, including sessions whose input is queued behind
 * their move onto a node (SQL only preselects candidates). */
export function activeNodeSessionIds(): string[] {
  return getDb().query<Pick<SessionRow, "id" | "activity_state" | "placement_status">, []>(`SELECT id, activity_state, placement_status FROM sessions
    WHERE (placement_status != 'server' AND activity_state = 'running')
      OR id IN (SELECT session_id FROM node_command_outbox WHERE state IN ('queued', 'dispatching'))`).all()
    .filter(row => nodeSessionActivity(row) !== "idle").map(row => row.id);
}
