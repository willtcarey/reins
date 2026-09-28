import type { NodeCommand, NodeResult } from "@reins/node-protocol";
import type { NodeHub, ServerState } from "../state.js";
import type { ClientPromptContent } from "../messages-store.js";
import { getSession } from "../session-store.js";
import { enqueueInput, pendingPlacementCommand } from "../node-command-store.js";
import { getDb } from "../db.js";
import { queueHydrationForUse } from "../models/session-ownership.js";
import { sendNodeCommand, type NodeLinks } from "../node-transport/commands.js";
import { requireSessionSource, resolveSessionSource, sessionBinding } from "./node-source.js";
import { hydrateSession } from "./session-relocation.js";

/**
 * Delivers one command to the node of the session's source over that node's link (a node without an
 * open link: submitted work is deferred, a control is `unavailable`), with the binding resolved from
 * product rows. Moves (`session.hydrate`) go through session relocation, to the node of the target
 * source. Every hydration is an outbox command queued ahead of the work that needs it (the lazy trigger,
 * startup recovery, the dispatcher's `not_found` re-hydration), so work reaching a session at rest on the
 * server is behind a move that failed: it fails with that move's reason (abort answers `aborted: false`:
 * nothing runs on the server).
 */
export async function deliverToNode(links: NodeLinks, command: NodeCommand): Promise<NodeResult> {
  if (command.op === "session.hydrate") return hydrateSession(links, command.sessionId, command.targetSourceId);
  const row = getSession(command.sessionId);
  if (row?.placement_status === "server") {
    if (command.op === "session.abort") return { ok: true, value: { kind: "aborted", aborted: false } };
    return { ok: false, error: { code: "unavailable", retryable: false,
      message: `Moving the session to its node failed: ${row.status_error ?? "the session is at rest on the server"}` } };
  }
  const { binding, nodeId } = sessionBinding(command.sessionId);
  return sendNodeCommand(links.link(nodeId), command, binding, links.timeouts);
}

/** Validates the session's current source and persists input synchronously, so a caller can enqueue
 * inside its own transaction; wake the hub after that transaction commits. A session at rest on the
 * server is first queued for hydration onto its node, so the input waits behind the move (a replay of
 * input already stored queues nothing). Input for a node that is not connected waits in the outbox. */
export function enqueueSessionInput(sessionId: string, command: "prompt" | "steer", content: ClientPromptContent, clientId: string, sourceSessionId?: string): void {
  requireSessionSource(sessionId);
  enqueueInput(sessionId, command, content, clientId, sourceSessionId, () => queueHydrationForUse(sessionId));
}

/**
 * Resolves once the session is placed where commands can reach it, from its `placement_status`: at
 * once when it is at rest on the server (nothing runs there; work queues its hydrate first) or provisioned (also after a
 * failed move returned it there); after its pending provision or move is delivered when it is
 * provisioning or moving (so a command right after creation cannot bypass or race provisioning);
 * rejects when its provisioning failed or its pending work waits on a node that is not connected.
 */
export async function waitUntilProvisioned(nodes: NodeHub, sessionId: string): Promise<void> {
  const row = getSession(sessionId);
  if (!row) return;
  if (row.placement_status === "provision_failed") throw new Error(`Session provisioning failed: ${row.status_error ?? "unknown error"}`);
  if (row.placement_status !== "provisioning" && row.placement_status !== "moving") return;
  const pending = pendingPlacementCommand(sessionId);
  if (!pending) return;
  const placed = resolveSessionSource(row);
  if (pending.state === "queued" && (!placed || !nodes.connected(placed.nodeId))) {
    throw new Error(`Execution source unavailable; session ${row.placement_status === "moving" ? "move" : "provisioning"} queued`);
  }
  await nodes.commandSettled(pending.id);
  return waitUntilProvisioned(nodes, sessionId);
}

/** Session commands resolve the current source first. Input is queued in the outbox; immediate
 * controls wait for the session's placement and go to its node at once. */
export async function executeSessionCommand(
  state: ServerState,
  sessionId: string,
  command: "prompt" | "steer" | "abort" | "resumePending",
  content?: ClientPromptContent,
  clientId?: string,
  sourceSessionId?: string,
): Promise<void> {
  if (command === "prompt" || command === "steer") {
    if (!content || !clientId) throw new Error("Input requires content and clientId");
    enqueueSessionInput(sessionId, command, content, clientId, sourceSessionId);
    void state.nodes.wake();
    return;
  }
  requireSessionSource(sessionId);
  // Resuming a session at rest on the server needs it on its node first: queue the lazy hydrate.
  if (command === "resumePending" && getDb().transaction(() => queueHydrationForUse(sessionId))()) void state.nodes.wake();
  await waitUntilProvisioned(state.nodes, sessionId);
  const input = { op: command === "abort" ? "session.abort" as const : "session.resumePending" as const, sessionId };
  const result = await state.nodes.send(input);
  if (!result.ok) throw new Error(result.error.message);
}
