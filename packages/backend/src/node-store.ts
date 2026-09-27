import { getDb } from "./db.js";

export interface Source { id: number; project_id: number; node_id: string; path: string }

export function getSource(id: number): Source | null {
  return getDb().query<Source, [number]>("SELECT * FROM sources WHERE id = ?").get(id) ?? null;
}

export function internalSource(projectId: number): Source {
  const source = getDb().query<Source, [number]>("SELECT * FROM sources WHERE project_id = ? AND node_id = 'internal' ORDER BY id LIMIT 1").get(projectId);
  if (!source) throw new Error(`Internal source not found for project ${projectId}`);
  return source;
}

export function createSource(projectId: number, nodeId: string, path: string): Source {
  return getDb().query<Source, [number, string, string]>("INSERT INTO sources (project_id, node_id, path) VALUES (?, ?, ?) RETURNING *").get(projectId, nodeId, path)!;
}

export interface NodeInfo { id: string; name: string }

/** The nodes holding a source for the project, in name order. */
export function listProjectNodes(projectId: number): NodeInfo[] {
  return getDb().query<NodeInfo, [number]>(`SELECT DISTINCT nodes.id, nodes.name FROM nodes JOIN sources ON sources.node_id = nodes.id
    WHERE sources.project_id = ? ORDER BY nodes.name, nodes.id`).all(projectId);
}

export function getNode(id: string): NodeInfo | null {
  return getDb().query<NodeInfo, [string]>("SELECT id, name FROM nodes WHERE id = ?").get(id) ?? null;
}
