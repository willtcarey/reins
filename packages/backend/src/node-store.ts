import { getDb } from "./db.js";

export interface Source { id: number; project_id: number; node_id: string; path: string }

export function getSource(id: number): Source | null {
  return getDb().query<Source, [number]>("SELECT * FROM sources WHERE id = ?").get(id) ?? null;
}

/** The project's default source, where a new session is placed unless the caller names one: its first
 * (lowest ID) source, i.e. the one it was created with. */
export function defaultSource(projectId: number): Source | null {
  return getDb().query<Source, [number]>("SELECT * FROM sources WHERE project_id = ? ORDER BY id LIMIT 1").get(projectId) ?? null;
}

export function createSource(projectId: number, nodeId: string, path: string): Source {
  return getDb().query<Source, [number, string, string]>("INSERT INTO sources (project_id, node_id, path) VALUES (?, ?, ?) RETURNING *").get(projectId, nodeId, path)!;
}

export interface NodeInfo { id: string; name: string }

/** Every node, in name order, with whether it holds a source for the project. */
export function listNodesForProject(projectId: number): Array<NodeInfo & { hasSource: boolean }> {
  return getDb().query<NodeInfo & { hasSource: number }, [number]>(`SELECT nodes.id, nodes.name,
      EXISTS (SELECT 1 FROM sources WHERE sources.node_id = nodes.id AND sources.project_id = ?) AS hasSource
    FROM nodes ORDER BY nodes.name, nodes.id`).all(projectId).map(node => ({ ...node, hasSource: node.hasSource === 1 }));
}

/** Every node, in name order. */
export function listNodes(): NodeInfo[] {
  return getDb().query<NodeInfo, []>("SELECT id, name FROM nodes ORDER BY name, id").all();
}

export function getNode(id: string): NodeInfo | null {
  return getDb().query<NodeInfo, [string]>("SELECT id, name FROM nodes WHERE id = ?").get(id) ?? null;
}

/** Sessions deleted on the server whose data `nodeId` has not yet acknowledged dropping (`session.delete`).
 * Recorded for every node by a trigger on session deletion (migration 040). */
export function pendingSessionDeletions(nodeId: string): string[] {
  return getDb().query<{ session_id: string }, [string]>("SELECT session_id FROM node_session_deletions WHERE node_id = ? ORDER BY rowid").all(nodeId).map(row => row.session_id);
}

export function clearSessionDeletion(sessionId: string, nodeId: string): void {
  getDb().query("DELETE FROM node_session_deletions WHERE session_id = ? AND node_id = ?").run(sessionId, nodeId);
}
