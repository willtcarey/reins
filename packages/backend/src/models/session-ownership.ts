/**
 * Which node a session belongs to, and moving it (ADR-015). The server's storage is the session's only
 * copy, so a session has no placement to track: it runs on the node of its source (`source_id`), which
 * serves its commands and alone may read and write it. Moving an idle session is one `UPDATE` of its
 * source; the node it left is told `session.close` (best effort: every call a node that misses it
 * still makes for the session is refused, as it is not the session's node any more).
 */
import { getDb } from "../db.js";
import { getSession, type SessionRow } from "../session-store.js";
import { getSource, listNodesForProject, type Source } from "../node-store.js";
import { nodeSessionActivity } from "./node-session-activity.js";

/** A move's preconditions do not hold (active run, pending work). */
export class SessionMoveConflict extends Error {
  constructor(message: string) { super(message); this.name = "SessionMoveConflict"; }
}

/** The node a source belongs to, or null if the source is gone. */
function nodeOf(sourceId: number | null): string | null {
  return sourceId === null ? null : getSource(sourceId)?.node_id ?? null;
}

/** The node of the session's source: where it runs. */
export function sessionNode(row: Pick<SessionRow, "source_id">): string | null {
  return nodeOf(row.source_id);
}

/**
 * A node, and whether the session can move there: not to the node it is on (`current`), nor to one
 * with no source for its project (`no_source`).
 */
export type SessionMoveTarget = { nodeId: string; name: string } & (
  | { eligible: true }
  | { eligible: false; reason: "current" | "no_source" }
);

/** Every node, eligible move targets first, each group in name order. */
export function sessionMoveTargets(row: Pick<SessionRow, "project_id" | "source_id">): SessionMoveTarget[] {
  const currentNode = sessionNode(row);
  const targets = listNodesForProject(row.project_id).map((node): SessionMoveTarget => {
    const target = { nodeId: node.id, name: node.name };
    if (node.id === currentNode) return { ...target, eligible: false, reason: "current" };
    if (!node.hasSource) return { ...target, eligible: false, reason: "no_source" };
    return { ...target, eligible: true };
  });
  return [...targets.filter(target => target.eligible), ...targets.filter(target => !target.eligible)];
}

/**
 * Fencing for every node→server call about a session (`storage.*`, `session.started`/`settled`,
 * `session.event`, `attachment.*`, `script.*`, `project.createTask`): only the node of the session's
 * source may read or write it.
 */
export function nodeOwnsSession(sessionId: string, nodeId: string): boolean {
  const row = getSession(sessionId);
  return !!row && nodeOf(row.source_id) === nodeId;
}

/** A source of the session's project on `nodeId`: where a move onto that node binds the session. */
function projectSourceOn(projectId: number, nodeId: string): Source | null {
  return getDb().query<Source, [number, string]>("SELECT * FROM sources WHERE project_id = ? AND node_id = ? ORDER BY id LIMIT 1").get(projectId, nodeId) ?? null;
}

/**
 * A session moves only when idle on the server: no active run and no pending input
 * (`nodeSessionActivity`) and no other queued or undelivered command. Every commit of its last run went
 * through the server, so nothing is left behind on the node it leaves.
 */
function assertIdleForMove(row: SessionRow): void {
  if (nodeSessionActivity(row) !== "idle") throw new SessionMoveConflict("Session has an active run or pending input; try again when it is idle");
  if (getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ? AND state IN ('queued', 'dispatching') LIMIT 1").get(row.id)) {
    throw new SessionMoveConflict("Session has pending work; try again when it is delivered");
  }
}

/**
 * The explicit move (`POST /api/sessions/:id/move`) to a node: in one transaction, checks the session is
 * idle and re-points it at the target node's source; from then on its commands go to that node and the
 * previous one's calls for it are refused. Returns the node it left (null when it was already on the
 * target: nothing changes), or undefined when there is no such session; the caller sends that node
 * `session.close`. Throws `SessionMoveConflict` when the session is busy or the node has no source for
 * its project.
 */
export function requestSessionMove(sessionId: string, nodeId: string): { previousNodeId: string | null } | undefined {
  return getDb().transaction(() => {
    const row = getSession(sessionId);
    if (!row) return undefined;
    const target = projectSourceOn(row.project_id, nodeId);
    if (!target) throw new SessionMoveConflict(`Node ${nodeId} has no source for this session's project`);
    const previousNodeId = sessionNode(row);
    if (previousNodeId === nodeId) return { previousNodeId: null };
    assertIdleForMove(row);
    getDb().query("UPDATE sessions SET source_id = ? WHERE id = ?").run(target.id, sessionId);
    return { previousNodeId };
  })();
}
