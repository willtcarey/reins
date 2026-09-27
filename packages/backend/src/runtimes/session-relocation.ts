import type { NodeResult } from "@reins/node/contract";
import { piSnapshotSummary } from "@reins/node/pi-storage";
import type { ServerState } from "../state.js";
import { getDb } from "../db.js";
import { getSession } from "../session-store.js";
import { getTask } from "../task-store.js";
import { DeliveryDeferred } from "../models/node-command-transport.js";
import { recordHydration } from "../models/session-ownership.js";
import { provisionForSession, sendInternalRelocation } from "./internal-node.js";
import type { NodeCommandTimeouts } from "../node-transport/commands.js";

type NodeRejection = Extract<NodeResult, { ok: false }>["error"];
const failed = (code: NodeRejection["code"], message: string): NodeResult => ({ ok: false, error: { code, message, retryable: false } });

/** A node's retryable rejection (it lost the server connection mid-pull, or its outbox is not yet
 * delivered) requeues the move instead of failing it: replays converge by content on the node. */
function deferRetryable(result: NodeResult): NodeResult {
  if (!result.ok && result.error.retryable) throw new DeliveryDeferred(result.error.message);
  return result;
}

/** A legacy server-owned session must not also be live on the server once a node owns it: an idle
 * runtime is closed and dropped from `state.sessions`; a running one blocks the move. */
async function closeLegacyRuntime(state: ServerState, sessionId: string): Promise<NodeResult | null> {
  const managed = state.sessions.get(sessionId);
  if (!managed) return null;
  if (managed.runtime.isStreaming()) return failed("busy", "Session is running on the server; try again when it is idle");
  state.sessions.delete(sessionId);
  await managed.runtime.close();
  return null;
}

/**
 * Delivers `session.hydrate` onto the node of `targetSourceId`: resolves, at delivery time, the binding
 * for that source, the task snapshot from the server's task row and the summary of the server's copy
 * (its next seq, row counts and digest), and sends them; the node pulls the rows itself, replacing any
 * copy it still holds. A node-owned session was already re-pointed at the target when the move was
 * queued (`requestSessionMove`); a session at rest on the server is re-pointed here, which is what lets
 * that node read it, and its owner flips atomically with the command's settlement (`commitMove`), or in
 * `hydrateForDelivery` for hydrations outside the outbox.
 */
export async function hydrateSession(state: ServerState, sessionId: string, commandId: string, targetSourceId: number, timeouts?: NodeCommandTimeouts): Promise<NodeResult> {
  const row = getSession(sessionId);
  if (!row) return failed("not_found", `Session not found: ${sessionId}`);
  if (row.storage_owner === "server") {
    const busy = await closeLegacyRuntime(state, sessionId);
    if (busy) return busy;
    if (row.source_id !== targetSourceId) getDb().query("UPDATE sessions SET source_id = ? WHERE id = ? AND storage_owner = 'server'").run(targetSourceId, sessionId);
  } else if (row.source_id !== targetSourceId) {
    // The move re-pointed the session at its target when it was queued; a later move superseded this one.
    return failed("invalid_request", `Session ${sessionId} was moved to another source`);
  }
  let snapshot;
  try { snapshot = piSnapshotSummary(getDb(), sessionId); }
  catch (error) { return failed("invalid_request", error instanceof Error ? error.message : String(error)); }
  const taskRow = row.task_id === null ? null : getTask(row.task_id);
  const task = taskRow ? { title: taskRow.title, description: taskRow.description, branchName: taskRow.branch_name } : null;
  const { binding } = provisionForSession(sessionId, targetSourceId);
  return deferRetryable(await sendInternalRelocation(state, { op: "session.hydrate", sessionId, targetSourceId }, binding, commandId, { task, snapshot }, timeouts));
}

/**
 * Hydrates a session outside the outbox, before delivering work that needs it on the node: a session
 * at rest on the server that reached the legacy target (its queued hydrate was interrupted by a restart,
 * or the work predates this path), or a node-owned session whose node answered `not_found` (its node
 * data is missing: it is re-hydrated from the server's replica). On success the owner flips and the
 * hydration is recorded; throws DeliveryDeferred like the outbox path, so the work waiting on it requeues.
 */
export async function hydrateForDelivery(state: ServerState, sessionId: string, timeouts?: NodeCommandTimeouts): Promise<NodeResult> {
  const row = getSession(sessionId);
  if (!row) return failed("not_found", `Session not found: ${sessionId}`);
  const id = crypto.randomUUID();
  const result = await hydrateSession(state, sessionId, id, row.source_id, timeouts);
  if (!result.ok) return { ok: false, error: { ...result.error, message: `Moving the session to its node failed: ${result.error.message}` } };
  recordHydration(sessionId, row.source_id, id);
  return result;
}
