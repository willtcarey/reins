/**
 * Where a session's canonical state lives, and the moves between owners. The server is the hub: a
 * session is either at rest on the server (legacy `storage_owner = "server"` sessions; the server's Pi
 * tables are canonical) or owned by one node (`storage_owner = "internal-node"`; the server holds an exact
 * replica). Every move is a `session.hydrate` of the server's copy onto the target node. There is no
 * release and no direct node-to-node transfer: the previous owner is told nothing.
 *
 * The state machine needs no column beyond `storage_owner` and `source_id`: an in-progress move is its
 * `session.hydrate` row in `node_command_outbox`, queued or being delivered.
 *
 *   at rest on server ──hydrate queued──▶ hydrating to N ──node acknowledged──▶ owned by N
 *   owned by A (idle) ──owner switched to B, hydrate queued──▶ hydrating to B ──node acknowledged──▶ owned by B
 *
 * Every transition commits in one server transaction with its outbox row, so a replay or a crash
 * converges (the node's side is idempotent by content). A node-owned session switches owner when the
 * move is queued, which fences the previous owner at once (`nodeOwnsSession`); a session at rest flips
 * when its hydrate settles. Input submitted during a move waits in the outbox behind it: the outbox
 * delivers a session's commands in order.
 */
import { laneConfig } from "@earendil-works/pi-agent-core";
import type { NodeResult } from "@reins/node/contract";
import { getDb } from "../db.js";
import { getSession, type SessionRow } from "../session-store.js";
import { getSource, type Source } from "../node-store.js";
import { enqueueSetModel } from "../node-command-store.js";
import { nodeSessionActivity } from "./node-session-activity.js";

export type SessionLocation =
  | { state: "server" }
  | { state: "hydrating"; nodeId: string }
  | { state: "node"; nodeId: string };

/** A move's preconditions do not hold (active run, pending work, a move in the other direction). */
export class SessionMoveConflict extends Error {
  constructor(message: string) { super(message); this.name = "SessionMoveConflict"; }
}

interface MoveRow { id: string; targetSourceId: number }
/** The session's move still being delivered, if any (the first queued/dispatching hydrate). */
export function pendingMove(sessionId: string): MoveRow | null {
  return getDb().query<MoveRow, [string]>(`SELECT id, json_extract(command_json, '$.targetSourceId') AS targetSourceId
    FROM node_command_outbox WHERE session_id = ? AND state IN ('queued', 'dispatching')
      AND json_extract(command_json, '$.op') = 'session.hydrate' ORDER BY rowid LIMIT 1`).get(sessionId) ?? null;
}

/** The node a source belongs to, or null if the source is gone. */
function nodeOf(sourceId: number | null): string | null {
  return sourceId === null ? null : getSource(sourceId)?.node_id ?? null;
}

export function sessionLocation(row: Pick<SessionRow, "id" | "storage_owner" | "source_id">): SessionLocation {
  const move = pendingMove(row.id);
  if (move) return { state: "hydrating", nodeId: nodeOf(move.targetSourceId) ?? "unknown" };
  return row.storage_owner === "server" ? { state: "server" } : { state: "node", nodeId: nodeOf(row.source_id) ?? "unknown" };
}

/**
 * Fencing for node→server reports and tool calls (`session.committed`, `session.started`/`settled`,
 * `session.event`, `attachment.store`, `script.*`, `project.createTask`): only the node that owns the
 * session may write to it. Once the session was moved to another node (or while a session at rest is
 * still hydrating) the sender owns nothing.
 */
export function nodeOwnsSession(sessionId: string, nodeId: string): boolean {
  const row = getSession(sessionId);
  return !!row && row.storage_owner === "internal-node" && nodeOf(row.source_id) === nodeId;
}

/** Reads (`session.snapshot`, `attachment.fetch`) are open to the node of the session's current source:
 * its owner, or, for a session at rest on the server, the node it would move to (a hydrate re-points the
 * session at its target source first), which is how a hydrating node pulls it. */
export function nodeMayReadSession(sessionId: string, nodeId: string): boolean {
  const row = getSession(sessionId);
  return !!row && nodeOf(row.source_id) === nodeId;
}

function insertMove(sessionId: string, command: { op: "session.hydrate"; targetSourceId: number }, state: "queued" | "admitted" = "queued", id: string = crypto.randomUUID()): string {
  getDb().query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES (?, ?, ?, ?)").run(id, sessionId, JSON.stringify(command), state);
  return id;
}

function hasLane(sessionId: string): boolean {
  const address = laneConfig("main");
  return !!getDb().query("SELECT 1 FROM pi_values WHERE session_id = ? AND namespace = ? AND key = ?").get(sessionId, address.namespace, address.key);
}

/**
 * Lazy trigger, synchronous so it runs inside the caller's transaction ahead of the work it enables:
 * a session at rest on the server that is used (new input, a model change) is first hydrated onto its
 * current source's node, then the work is delivered there. Queues `session.hydrate` unless one is
 * already pending. A copy whose Pi lane was never created (a legacy session that never ran) gets the
 * row's model as a queued `session.setModel` behind the hydrate, which seeds the lane on the node,
 * unless `seedModel` is false because the caller queues its own model change. Returns the hydrate
 * command ID, or null when nothing was queued.
 */
export function queueHydrationForUse(sessionId: string, { seedModel = true }: { seedModel?: boolean } = {}): string | null {
  const row = getSession(sessionId);
  if (!row || row.storage_owner !== "server" || pendingMove(sessionId)) return null;
  const id = insertMove(sessionId, { op: "session.hydrate", targetSourceId: row.source_id });
  if (seedModel && !hasLane(sessionId) && row.model_provider && row.model_id) {
    enqueueSetModel(sessionId, { provider: row.model_provider, modelId: row.model_id, ...(row.thinking_level && row.thinking_level !== "off" ? { thinkingLevel: row.thinking_level } : {}) });
  }
  return id;
}

/**
 * Applies a delivered hydrate's acknowledgement inside the transaction that settles its outbox row, so a
 * session at rest on the server becomes node-owned exactly when the command is recorded admitted (a
 * node-owned session already points at its target). Returns the result to record.
 */
export function commitMove(sessionId: string, command: { op: "session.hydrate"; targetSourceId: number }, result: NodeResult): NodeResult {
  if (result.ok && result.value.kind === "hydrated") markHydrated(sessionId, command.targetSourceId);
  return result;
}

function markHydrated(sessionId: string, targetSourceId: number): void {
  getDb().query("UPDATE sessions SET storage_owner = 'internal-node', source_id = ? WHERE id = ?").run(targetSourceId, sessionId);
}

/**
 * Records a hydration performed outside the outbox (the legacy target hydrating before it delivers work,
 * or a node answering `not_found` and being re-hydrated): the owner flips and an admitted hydrate row is
 * stored as the session's open record, replacing hydrations interrupted by a restart (`unknown`).
 */
export function recordHydration(sessionId: string, targetSourceId: number, id: string): void {
  getDb().transaction(() => {
    markHydrated(sessionId, targetSourceId);
    getDb().query("DELETE FROM node_command_outbox WHERE session_id = ? AND state = 'unknown' AND json_extract(command_json, '$.op') = 'session.hydrate'").run(sessionId);
    insertMove(sessionId, { op: "session.hydrate", targetSourceId }, "admitted", id);
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
 * The explicit move (`POST /api/sessions/:id/move`) to a node. For a node-owned session, in one
 * transaction: checks it is idle (`assertIdleForMove`), switches its owner to the target node's source
 * (from then on the previous owner's writes are refused with `not_owner`; it is told nothing) and queues
 * `session.hydrate` for the target. A session at rest on the server just queues the hydrate. Returns the
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
    if (location.state === "hydrating") {
      if (location.nodeId === nodeId) return location;
      throw new SessionMoveConflict(`Session is being moved to node ${location.nodeId}`);
    }
    if (location.state === "node") {
      if (location.nodeId === nodeId) return location;
      assertIdleForMove(row);
      getDb().query("UPDATE sessions SET source_id = ? WHERE id = ?").run(target.id, sessionId);
    }
    insertMove(sessionId, { op: "session.hydrate", targetSourceId: target.id });
    return sessionLocation(row);
  })();
}
