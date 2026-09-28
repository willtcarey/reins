import type { NodeSessionBinding } from "@reins/node-protocol";
import { defaultSource, getSource, type Source } from "../node-store.js";
import { getSession, type SessionRow } from "../session-store.js";

/** A session's execution source and the node it belongs to. */
export interface SessionSource { source: Source; nodeId: string }

/** The session's source (or `sourceId`, another source of its project), or null when it is gone or
 * belongs to another project. Where the session's commands go: to that source's node. */
export function resolveSessionSource(row: Pick<SessionRow, "source_id" | "project_id">, sourceId = row.source_id): SessionSource | null {
  const source = getSource(sourceId);
  return source && source.project_id === row.project_id ? { source, nodeId: source.node_id } : null;
}

/** `resolveSessionSource`, throwing when the source is unavailable. */
export function requireSessionSource(sessionId: string, sourceId?: number): SessionSource & { row: SessionRow } {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const resolved = resolveSessionSource(row, sourceId);
  if (!resolved) throw new Error(`Execution source unavailable for session ${sessionId}`);
  return { ...resolved, row };
}

/** The node binding for the session's source (or `sourceId`: the target of a hydrate) and its node.
 * Product identity and path resolution stay server-side; no server DB handle reaches node code. */
export function sessionBinding(sessionId: string, sourceId?: number): { binding: NodeSessionBinding; nodeId: string } {
  const { row, source, nodeId } = requireSessionSource(sessionId, sourceId);
  return { binding: { sourceId: source.id, cwd: source.path, createdAt: row.created_at, parentSessionId: row.parent_session_id }, nodeId };
}

/** Where a new session is placed: the named source, else the project's default source (`defaultSource`).
 * Selection is server policy, not a live connectivity check: a session whose node is not connected is
 * created and its provisioning waits in the outbox until the node connects. */
export function selectCreationSource(projectId: number, sourceId?: number): Source {
  const source = sourceId === undefined ? defaultSource(projectId) : getSource(sourceId);
  if (!source || source.project_id !== projectId) throw new Error(`Execution source unavailable for project ${projectId}`);
  return source;
}
