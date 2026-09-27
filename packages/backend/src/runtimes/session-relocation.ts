import type { NodeResult } from "@reins/node/contract";
import { piSnapshotSummary } from "@reins/node/pi-storage";
import { getDb } from "../db.js";
import { getSession } from "../session-store.js";
import { getTask } from "../task-store.js";
import { DeliveryDeferred } from "../models/node-command-delivery.js";
import { recordHydration } from "../models/session-ownership.js";
import { sessionBinding } from "./node-source.js";
import { sendRelocationCommand, type NodeLinks } from "../node-transport/commands.js";

type NodeRejection = Extract<NodeResult, { ok: false }>["error"];
const failed = (code: NodeRejection["code"], message: string): NodeResult => ({ ok: false, error: { code, message, retryable: false } });

/** A node's retryable rejection (it lost the server connection mid-pull, or its outbox is not yet
 * delivered) requeues the move instead of failing it: replays converge by content on the node. */
function deferRetryable(result: NodeResult): NodeResult {
  if (!result.ok && result.error.retryable) throw new DeliveryDeferred(result.error.message);
  return result;
}

/**
 * Delivers `session.hydrate` onto the node of `targetSourceId` (over its link in `links`): resolves, at delivery time, the binding
 * for that source, the task snapshot from the server's task row and the summary of the server's copy
 * (its next seq, row counts and digest), and sends them; the node pulls the rows itself, replacing any
 * copy it still holds. The session was re-pointed at the target when the move was queued (`queueMove`),
 * which is what lets that node read it; it becomes `provisioned` there atomically with the command's
 * settlement (`commitPlacement`), or in `hydrateForDelivery` for hydrations outside the outbox.
 */
export async function hydrateSession(links: NodeLinks, sessionId: string, targetSourceId: number): Promise<NodeResult> {
  const row = getSession(sessionId);
  if (!row) return failed("not_found", `Session not found: ${sessionId}`);
  if (row.source_id !== targetSourceId) {
    // The move re-pointed the session at its target when it was queued; a later move superseded this one.
    return failed("invalid_request", `Session ${sessionId} was moved to another source`);
  }
  let snapshot;
  try { snapshot = piSnapshotSummary(getDb(), sessionId); }
  catch (error) { return failed("invalid_request", error instanceof Error ? error.message : String(error)); }
  const taskRow = row.task_id === null ? null : getTask(row.task_id);
  const task = taskRow ? { title: taskRow.title, description: taskRow.description, branchName: taskRow.branch_name } : null;
  const { binding, nodeId } = sessionBinding(sessionId, targetSourceId);
  return deferRetryable(await sendRelocationCommand(links.link(nodeId), { op: "session.hydrate", sessionId, targetSourceId }, binding, { task, snapshot }, links.timeouts));
}

/**
 * Hydrates a session outside the outbox, before delivering work that needs it on the node: a session
 * at rest on the server whose work reached the node target without a move ahead of it (its queued move
 * was interrupted by a restart), or a session whose node answered `not_found` (its node data is missing:
 * it is re-hydrated from the server's replica). The outcome is recorded on the session
 * (`recordHydration`: `provisioned`, or the reason in `status_error` with its placement unchanged);
 * throws DeliveryDeferred like the outbox path, so the work waiting on it requeues.
 */
export async function hydrateForDelivery(links: NodeLinks, sessionId: string): Promise<NodeResult> {
  const row = getSession(sessionId);
  if (!row) return failed("not_found", `Session not found: ${sessionId}`);
  const result = await hydrateSession(links, sessionId, row.source_id);
  recordHydration(sessionId, row.source_id, result);
  return result.ok ? result : { ok: false, error: { ...result.error, message: `Moving the session to its node failed: ${result.error.message}` } };
}
