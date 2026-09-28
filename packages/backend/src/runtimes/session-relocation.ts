import type { NodeResult } from "@reins/node/contract";
import { piSnapshotSummary } from "@reins/node/pi-storage";
import { getDb } from "../db.js";
import { getSession } from "../session-store.js";
import { getTask } from "../task-store.js";
import { DeliveryDeferred } from "../models/node-command-delivery.js";
import { sessionBinding } from "./node-source.js";
import { sendNodeCommand, type NodeLinks } from "../node-transport/commands.js";

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
 * settlement (`commitPlacement`). Every hydrate is an outbox command (`queueMove`).
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
  return deferRetryable(await sendNodeCommand(links.link(nodeId), { op: "session.hydrate", sessionId, targetSourceId }, binding, links.timeouts, { task, snapshot }));
}

