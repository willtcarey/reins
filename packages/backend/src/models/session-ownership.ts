/**
 * Where a session lives, and the moves between placements. Its `placement_status` column is the single
 * source of truth (see `PlacementStatus`), written in the same server transaction as the outbox change
 * that causes it; the outbox is only a queue (settled commands are deleted), so no state is read from
 * settled rows. The server is the hub: a session is either at rest on the server (`server`: its server
 * Pi tables are canonical; the server never runs it) or on one node (`provisioning`/`provisioned`: the
 * server holds an exact replica). Every move is a `session.hydrate` of the server's copy onto the target
 * node. There is no release and no direct node-to-node transfer: the previous owner is told nothing.
 *
 *   created ──provision queued──▶ provisioning ──admitted──▶ provisioned   (failed: provision_failed)
 *   server / provisioned ──hydrate queued (source_id = target)──▶ moving ──admitted──▶ provisioned
 *                                                      (failed: back to server / provisioned + status_error)
 *
 * Queueing a move re-points the session at the target source and marks it `moving`, which fences the
 * previous owner at once (`nodeOwnsSession`). A failed move returns the session to the resting state it
 * left (`revertTo` on the hydrate command: `server`, or `provisioned` on its previous source) with the
 * reason in `status_error`. Input submitted during a move waits in the outbox behind it: the outbox
 * delivers a session's commands in order.
 */
import { laneConfig } from "@earendil-works/pi-agent-core";
import type { NodeResult } from "@reins/node/contract";
import { z } from "zod";
import { getDb } from "../db.js";
import { getSession, setPlacementStatus, type PlacementStatus, type SessionRow } from "../session-store.js";
import { getSource, listNodesForProject, type Source } from "../node-store.js";
import { enqueueSetModel } from "../node-command-store.js";
import { nodeSessionActivity } from "./node-session-activity.js";

export type SessionLocation =
  | { state: "server" }
  | { state: "moving"; nodeId: string }
  | { state: "node"; nodeId: string };

/** A move's preconditions do not hold (active run, pending work, a move in the other direction). */
export class SessionMoveConflict extends Error {
  constructor(message: string) { super(message); this.name = "SessionMoveConflict"; }
}

/** The node a source belongs to, or null if the source is gone. */
function nodeOf(sourceId: number | null): string | null {
  return sourceId === null ? null : getSource(sourceId)?.node_id ?? null;
}

/** From the placement column: `server` is at rest on the server, `moving` is on its way to the node of
 * its (target) source; otherwise the session is on (or being provisioned on) its source's node. */
export function sessionLocation(row: Pick<SessionRow, "source_id" | "placement_status">): SessionLocation {
  if (row.placement_status === "server") return { state: "server" };
  if (row.placement_status === "moving") return { state: "moving", nodeId: nodeOf(row.source_id) ?? "unknown" };
  return { state: "node", nodeId: nodeOf(row.source_id) ?? "unknown" };
}

/**
 * A node, and whether the session can move there: not to the node it is on or moving to (`current`),
 * nor to one with no source for its project (`no_source`).
 */
export type SessionMoveTarget = { nodeId: string; name: string } & (
  | { eligible: true }
  | { eligible: false; reason: "current" | "no_source" }
);

/** Every node, eligible move targets first, each group in name order. */
export function sessionMoveTargets(row: Pick<SessionRow, "project_id">, location: SessionLocation): SessionMoveTarget[] {
  const currentNode = location.state === "server" ? null : location.nodeId;
  const targets = listNodesForProject(row.project_id).map((node): SessionMoveTarget => {
    const target = { nodeId: node.id, name: node.name };
    if (node.id === currentNode) return { ...target, eligible: false, reason: "current" };
    if (!node.hasSource) return { ...target, eligible: false, reason: "no_source" };
    return { ...target, eligible: true };
  });
  return [...targets.filter(target => target.eligible), ...targets.filter(target => !target.eligible)];
}

/**
 * Fencing for node→server reports and tool calls (`session.committed`, `session.started`/`settled`,
 * `session.event`, `attachment.store`, `script.*`, `project.createTask`): only the node the session is
 * placed on may write to it. A session at rest on the server, or moving (its target has nothing to report
 * until the hydrate settles; its previous owner was re-pointed away), accepts no writes, nor does a node
 * the session was moved away from.
 */
export function nodeOwnsSession(sessionId: string, nodeId: string): boolean {
  const row = getSession(sessionId);
  return !!row && row.placement_status !== "server" && row.placement_status !== "moving" && nodeOf(row.source_id) === nodeId;
}

/** Reads (`session.snapshot`, `attachment.fetch`) are open to the node of the session's current source:
 * its owner, or, for a session at rest on the server, the node it would move to (a hydrate re-points the
 * session at its target source first), which is how a hydrating node pulls it. */
export function nodeMayReadSession(sessionId: string, nodeId: string): boolean {
  const row = getSession(sessionId);
  return !!row && nodeOf(row.source_id) === nodeId;
}

/** The resting state a failed move returns the session to: at rest on the server, or provisioned on the
 * source it left. Stored with the hydrate command (server-side only: the contract schema strips it). */
export interface MoveRevert { status: Extract<PlacementStatus, "server" | "provisioned">; sourceId: number }

/** Queues the move and marks the session `moving` towards its target source, recording where a failed
 * move returns it; the caller's transaction. Clears the last failure's `status_error`. */
function queueMove(row: SessionRow, targetSourceId: number): string {
  const id = crypto.randomUUID();
  const revertTo: MoveRevert = { status: row.placement_status === "server" ? "server" : "provisioned", sourceId: row.source_id };
  getDb().query("UPDATE sessions SET source_id = ? WHERE id = ? AND source_id != ?").run(targetSourceId, row.id, targetSourceId);
  getDb().query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES (?, ?, ?, 'queued')")
    .run(id, row.id, JSON.stringify({ op: "session.hydrate", targetSourceId, revertTo }));
  setPlacementStatus(row.id, "moving");
  return id;
}

function hasLane(sessionId: string): boolean {
  const address = laneConfig("main");
  return !!getDb().query("SELECT 1 FROM pi_values WHERE session_id = ? AND namespace = ? AND key = ?").get(sessionId, address.namespace, address.key);
}

/**
 * Lazy trigger, synchronous so it runs inside the caller's transaction ahead of the work it enables:
 * a session at rest on the server that is used (new input, a model change) is first hydrated onto its
 * current source's node, then the work is delivered there. Queues `session.hydrate` (the session is
 * `moving`) unless one is already pending. A copy whose Pi lane was never created (a session that never ran) gets the
 * row's model as a queued `session.setModel` behind the hydrate, which seeds the lane on the node,
 * unless `seedModel` is false because the caller queues its own model change. Returns the hydrate
 * command ID, or null when nothing was queued.
 */
export function queueHydrationForUse(sessionId: string, { seedModel = true }: { seedModel?: boolean } = {}): string | null {
  const row = getSession(sessionId);
  if (!row || row.placement_status !== "server") return null;
  const id = queueMove(row, row.source_id);
  if (seedModel && !hasLane(sessionId) && row.model_provider && row.model_id) {
    enqueueSetModel(sessionId, { provider: row.model_provider, modelId: row.model_id, ...(row.thinking_level && row.thinking_level !== "off" ? { thinkingLevel: row.thinking_level } : {}) });
  }
  return id;
}

const failureMessage = (result: NodeResult) => result.ok ? null : result.error.message;

/** A stored hydrate's placement fields. Every hydrate carries its `revertTo` (written by `queueMove`;
 * migration 037 added it to older ones). */
const storedHydrate = z.object({
  targetSourceId: z.number().int(),
  revertTo: z.object({ status: z.enum(["server", "provisioned"]), sourceId: z.number().int() }),
});

/**
 * Applies a delivered provision's or move's result to the session's placement inside the transaction
 * that settles (and deletes) its outbox row (`commandJson` is the stored command). Provision:
 * `provisioned` (unchanged if a move was queued behind it meanwhile, which keeps it `moving`), else
 * `provision_failed`. Move: `provisioned` on the target source, else back to the resting state it left
 * (`revertTo`) with the reason in `status_error`. Other operations change nothing. Returns the result
 * to record.
 */
export function commitPlacement(sessionId: string, commandJson: string, result: NodeResult): NodeResult {
  const stored: unknown = JSON.parse(commandJson);
  const { op } = z.object({ op: z.string() }).parse(stored);
  if (op === "session.provision") {
    const row = getSession(sessionId);
    if (!result.ok) setPlacementStatus(sessionId, "provision_failed", failureMessage(result));
    else if (row?.placement_status === "provisioning") setPlacementStatus(sessionId, "provisioned");
  } else if (op === "session.hydrate") {
    const { targetSourceId, revertTo } = storedHydrate.parse(stored);
    if (result.ok) markHydrated(sessionId, targetSourceId);
    else revertMove(sessionId, revertTo, failureMessage(result) ?? "unknown error");
  }
  return result;
}

function markHydrated(sessionId: string, targetSourceId: number): void {
  getDb().query("UPDATE sessions SET source_id = ? WHERE id = ?").run(targetSourceId, sessionId);
  setPlacementStatus(sessionId, "provisioned");
}

/** A failed move: back to its resting state and source, with the reason. */
function revertMove(sessionId: string, { status, sourceId }: MoveRevert, error: string): void {
  getDb().query("UPDATE sessions SET source_id = ? WHERE id = ? AND source_id != ?").run(sourceId, sessionId, sourceId);
  setPlacementStatus(sessionId, status, error);
}

/**
 * Records a hydration performed outside the outbox (a session at rest on the server whose work reached
 * its node without a queued move, or a node answering `not_found` and being re-hydrated), which has no
 * outbox row of its own: on success the session is `provisioned` on that source; on failure it keeps its
 * resting placement and records the reason (the work waiting on it then fails with the same message).
 */
export function recordHydration(sessionId: string, targetSourceId: number, result: NodeResult): void {
  getDb().transaction(() => {
    if (result.ok) markHydrated(sessionId, targetSourceId);
    else getDb().query("UPDATE sessions SET status_error = ? WHERE id = ?").run(result.error.message, sessionId);
  })();
}

/** A source of the session's project on `nodeId`: where a hydrate onto that node binds the session. */
function projectSourceOn(projectId: number, nodeId: string): Source | null {
  return getDb().query<Source, [number, string]>("SELECT * FROM sources WHERE project_id = ? AND node_id = ? ORDER BY id LIMIT 1").get(projectId, nodeId) ?? null;
}

/**
 * A node-owned session moves only when idle on the server: no active run and no pending input
 * (`nodeSessionActivity`) and no other queued or undelivered command. `session.settled` is delivered
 * after the run's commits, in order, so a session idle on the server has a replica holding everything
 * through its last run; only commits the old owner made outside a run and had not delivered are lost.
 */
function assertIdleForMove(row: SessionRow): void {
  if (nodeSessionActivity(row) !== "idle") throw new SessionMoveConflict("Session has an active run or pending input; try again when it is idle");
  if (getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ? AND state IN ('queued', 'dispatching') LIMIT 1").get(row.id)) {
    throw new SessionMoveConflict("Session has pending work; try again when it is delivered");
  }
}

/**
 * The explicit move (`POST /api/sessions/:id/move`) to a node. In one transaction: for a session on a
 * node, checks it is idle (`assertIdleForMove`); then re-points the session at the target node's source
 * (from then on the previous owner's writes are refused with `not_owner`; it is told nothing), queues
 * `session.hydrate` for the target and marks it `moving`. Returns the
 * session's location (idempotent: a move already under way to, or done onto, that node is reported, not
 * queued again). Throws `SessionMoveConflict` when the session is busy, moving elsewhere or the node has
 * no source for its project. The caller wakes the dispatcher.
 */
export function requestSessionMove(sessionId: string, nodeId: string): SessionLocation | null {
  return getDb().transaction((): SessionLocation | null => {
    const row = getSession(sessionId);
    if (!row) return null;
    const target = projectSourceOn(row.project_id, nodeId);
    if (!target) throw new SessionMoveConflict(`Node ${nodeId} has no source for this session's project`);
    const location = sessionLocation(row);
    if (location.state === "moving") {
      if (location.nodeId === nodeId) return location;
      throw new SessionMoveConflict(`Session is being moved to node ${location.nodeId}`);
    }
    if (location.state === "node") {
      if (location.nodeId === nodeId) return location;
      assertIdleForMove(row);
    }
    queueMove(row, target.id);
    return sessionLocation(getSession(sessionId)!);
  })();
}
