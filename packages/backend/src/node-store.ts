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

/** The project's sources, its first (default) one first. */
export function listSources(projectId: number): Source[] {
  return getDb().query<Source, [number]>("SELECT * FROM sources WHERE project_id = ? ORDER BY id").all(projectId);
}

/** Throws a UNIQUE constraint error when a source of any project already has this node and path. */
export function createSource(projectId: number, nodeId: string, path: string): Source {
  return getDb().query<Source, [number, string, string]>("INSERT INTO sources (project_id, node_id, path) VALUES (?, ?, ?) RETURNING *").get(projectId, nodeId, path)!;
}

/** Throws a UNIQUE constraint error when another source already has this node and path. */
export function updateSourcePath(id: number, path: string): Source | null {
  return getDb().query<Source, [string, number]>("UPDATE sources SET path = ? WHERE id = ? RETURNING *").get(path, id) ?? null;
}

/** Removes a source no session is bound to (a session's source cannot be deleted). */
export function deleteSource(id: number): void {
  getDb().query("DELETE FROM sources WHERE id = ?").run(id);
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
