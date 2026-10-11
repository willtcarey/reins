/**
 * Which node a session belongs to, and moving it (ADR-015). The server's storage is the session's only
 * copy, so a session has no placement to track: its tools run on the node of its source (`source_id`).
 * Moving an idle session is one `UPDATE` of its source (the caller closes its live runtime, bound to the
 * source it left).
 */
import { getDb } from "../db.js";
import type { ProcessSessions } from "../state.js";
import { getSession, type SessionRow } from "../session-store.js";
import { getSource, listNodesForProject, type Source } from "../node-store.js";
import { sessionActivity } from "../models/session-activity.js";

/** A move's preconditions do not hold (an active run or submission). */
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

/** A source of the session's project on `nodeId`: where a move onto that node binds the session. */
function projectSourceOn(projectId: number, nodeId: string): Source | null {
  return getDb().query<Source, [number, string]>("SELECT * FROM sources WHERE project_id = ? AND node_id = ? ORDER BY id LIMIT 1").get(projectId, nodeId) ?? null;
}

/** A session moves only when idle (`sessionActivity`): no active run and no submission in progress. */
function assertIdleForMove(row: SessionRow, sessions: ProcessSessions): void {
  if (sessionActivity(row, sessions) !== "idle") throw new SessionMoveConflict("Session has an active run or pending input; try again when it is idle");
}

/**
 * The explicit move (`POST /api/sessions/:id/move`) to a node: in one transaction, checks the session is
 * idle and re-points it at the target node's source; from then on its tools run on that node. Returns the
 * node it left (null when it was already on the target: nothing changes), or undefined when there is no
 * such session; the caller closes its live runtime. Throws `SessionMoveConflict` when the session is busy
 * or the node has no source for its project.
 */
export function requestSessionMove(sessionId: string, nodeId: string, sessions: ProcessSessions): { previousNodeId: string | null } | undefined {
  return getDb().transaction(() => {
    const row = getSession(sessionId);
    if (!row) return undefined;
    const target = projectSourceOn(row.project_id, nodeId);
    if (!target) throw new SessionMoveConflict(`Node ${nodeId} has no source for this session's project`);
    const previousNodeId = sessionNode(row);
    if (previousNodeId === nodeId) return { previousNodeId: null };
    assertIdleForMove(row, sessions);
    getDb().query("UPDATE sessions SET source_id = ? WHERE id = ?").run(target.id, sessionId);
    return { previousNodeId };
  })();
}

/** The IDs of a session, or of the sessions of a task or a project: read before deleting them, so their
 * live runtimes can be closed first (`closeSessionRuntime`). */
export function sessionIdsIn(scope: { taskId: number } | { projectId: number }): string[] {
  const [column, id] = "taskId" in scope ? ["task_id", scope.taskId] : ["project_id", scope.projectId];
  return getDb().query<{ id: string }, [number]>(`SELECT id FROM sessions WHERE ${column} = ?`).all(id).map(row => row.id);
}
