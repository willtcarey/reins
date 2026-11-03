/**
 * Which node a session belongs to, and moving it (ADR-015). The server's storage is the session's only
 * copy, so a session has no placement to track: its tools run on the node of its source (`source_id`).
 * Moving an idle session to a node and path is one `UPDATE` of its source (the caller makes the source,
 * `ensureSource`, and closes its live runtime, bound to the source it left).
 */
import { getDb } from "../app-globals.js";
import type { OpenSessions } from "../state.js";
import { getSession, type SessionRow } from "../session-store.js";
import { getSource, listNodePathsForProject } from "../node-store.js";
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

/** A node a session can move to (one not removed): `current` when it is on it, with the paths its project's
 * sessions used there, the most recently used first (where it could go; another path can be typed). */
export interface SessionMoveTarget { nodeId: string; name: string; current: boolean; paths: string[] }

/** Every node not removed, in name order, with its project's paths on each. */
export function sessionMoveTargets(row: Pick<SessionRow, "project_id" | "source_id">): SessionMoveTarget[] {
  const currentNode = sessionNode(row);
  return listNodePathsForProject(row.project_id).map(node => ({ nodeId: node.id, name: node.name, current: node.id === currentNode, paths: node.paths }));
}

/** A session moves only when idle (`sessionActivity`): no active run and no submission in progress. */
function assertIdleForMove(row: SessionRow, sessions: OpenSessions): void {
  if (sessionActivity(row, sessions) !== "idle") throw new SessionMoveConflict("Session has an active run or pending input; try again when it is idle");
}

/**
 * The explicit move (`POST /api/sessions/:id/move`) to source `sourceId`: in one transaction, checks the
 * session is idle and re-points it; from then on its tools run there. Returns whether it moved (false when
 * it was already there: nothing changes), or undefined when there is no such session; the caller closes
 * its live runtime. Throws `SessionMoveConflict` when the session is busy.
 */
export function requestSessionMove(sessionId: string, sourceId: number, sessions: OpenSessions): { moved: boolean } | undefined {
  return getDb().transaction(() => {
    const row = getSession(sessionId);
    if (!row) return undefined;
    if (row.source_id === sourceId) return { moved: false };
    assertIdleForMove(row, sessions);
    getDb().query("UPDATE sessions SET source_id = ? WHERE id = ?").run(sourceId, sessionId);
    return { moved: true };
  })();
}

/** The IDs of a session, or of the sessions of a task or a project: read before deleting them, so their
 * live runtimes can be closed first (`closeSessionRuntime`). */
export function sessionIdsIn(scope: { taskId: number } | { projectId: number }): string[] {
  const [column, id] = "taskId" in scope ? ["task_id", scope.taskId] : ["project_id", scope.projectId];
  return getDb().query<{ id: string }, [number]>(`SELECT id FROM sessions WHERE ${column} = ?`).all(id).map(row => row.id);
}
