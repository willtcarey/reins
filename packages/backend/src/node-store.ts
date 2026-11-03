import { getDb } from "./app-globals.js";

/** A location: a path on a node, where sessions work (ADR-034). It belongs to no project: any session may
 * use it, and a project has one as its default source (`projects.default_source_id`). One row per node and path. */
export interface Source { id: number; node_id: string; path: string }

export function getSource(id: number): Source | null {
  return getDb().query<Source, [number]>("SELECT * FROM sources WHERE id = ?").get(id) ?? null;
}

/** The source of `path` on node `nodeId`, made if there is none (one row per node and path). */
export function upsertSource(nodeId: string, path: string): Source {
  return getDb().query<Source, [string, string]>(`INSERT INTO sources (node_id, path) VALUES (?, ?)
    ON CONFLICT (node_id, path) DO UPDATE SET path = excluded.path RETURNING *`).get(nodeId, path)!;
}

export function findSource(nodeId: string, path: string): Source | null {
  return getDb().query<Source, [string, string]>("SELECT * FROM sources WHERE node_id = ? AND path = ?").get(nodeId, path) ?? null;
}

/** The project's default source: where it was created, the default of a session with nothing better to
 * inherit. */
export function defaultSource(projectId: number): Source | null {
  return getDb().query<Source, [number]>(`SELECT sources.* FROM sources JOIN projects ON projects.default_source_id = sources.id
    WHERE projects.id = ?`).get(projectId) ?? null;
}

/** A node not removed, with the paths a project's sessions used on it, the most recently used first. */
export interface NodePaths { id: string; name: string; paths: string[] }

/** Every node not removed, in name order, each with the paths `projectId`'s sessions used there, most
 * recently used first (its default source first on its node when no session used it); no paths without a project. */
export function listNodePathsForProject(projectId: number | null): NodePaths[] {
  const nodes = getDb().query<{ id: string; name: string }, []>("SELECT id, name FROM nodes WHERE removed_at IS NULL ORDER BY name, id").all();
  if (projectId === null) return nodes.map(node => ({ ...node, paths: [] }));
  const used = getDb().query<{ node_id: string; path: string }, [number, number]>(`SELECT sources.node_id, sources.path FROM sources
      LEFT JOIN sessions ON sessions.source_id = sources.id AND sessions.project_id = ?1
    WHERE sessions.id IS NOT NULL OR sources.id = (SELECT default_source_id FROM projects WHERE id = ?2)
    GROUP BY sources.id ORDER BY MAX(sessions.updated_at) DESC NULLS LAST, sources.id`).all(projectId, projectId);
  return nodes.map(node => ({ ...node, paths: used.filter(source => source.node_id === node.id).map(source => source.path) }));
}

/** A node: `publicKey`, `hostname` and `pairedAt` once it redeemed a pairing code (the seeded local node
 * never did), `revokedAt` once it was revoked, `removedAt` once it was removed (its row stays: sessions
 * hang off its sources). */
export interface NodeRow { id: string; name: string; publicKey: string | null; hostname: string | null; pairedAt: string | null; revokedAt: string | null; removedAt: string | null }

const NODE_COLUMNS = "id, name, public_key AS publicKey, hostname, paired_at AS pairedAt, revoked_at AS revokedAt, removed_at AS removedAt";

export function getNode(id: string): NodeRow | null {
  return getDb().query<NodeRow, [string]>(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`).get(id) ?? null;
}

/** Every node not removed, in name order. */
export function listNodes(): NodeRow[] {
  return getDb().query<NodeRow, []>(`SELECT ${NODE_COLUMNS} FROM nodes WHERE removed_at IS NULL ORDER BY name, id`).all();
}

/** A source on a node in use, with the projects that use it: whose sessions work there, or whose default source it is. */
export interface NodeSource { id: number; path: string; projects: Array<{ id: number; name: string }> }

/** The sources in use on the node (by a session, or as a project's default source), by path. */
export function listSourcesOnNode(nodeId: string): NodeSource[] {
  const rows = getDb().query<{ id: number; path: string; projectId: number | null; projectName: string | null }, [string]>(`SELECT sources.id, sources.path,
      projects.id AS projectId, projects.name AS projectName
    FROM sources
      LEFT JOIN (SELECT DISTINCT source_id, project_id FROM sessions UNION SELECT default_source_id, id FROM projects) used ON used.source_id = sources.id
      LEFT JOIN projects ON projects.id = used.project_id
    WHERE sources.node_id = ? AND used.source_id IS NOT NULL
    ORDER BY sources.path, sources.id, projects.name, projects.id`).all(nodeId);
  const sources = new Map<number, NodeSource>();
  for (const row of rows) {
    const source = sources.get(row.id) ?? { id: row.id, path: row.path, projects: [] };
    sources.set(row.id, source);
    if (row.projectId !== null && !source.projects.some(project => project.id === row.projectId)) source.projects.push({ id: row.projectId, name: row.projectName! });
  }
  return [...sources.values()];
}

/** Throws a UNIQUE constraint error when another node already holds `publicKey`. */
export function insertPairedNode(node: { id: string; name: string; publicKey: string; hostname: string; pairedAt: string }): void {
  getDb().query("INSERT INTO nodes (id, name, public_key, hostname, paired_at) VALUES (?, ?, ?, ?, ?)")
    .run(node.id, node.name, node.publicKey, node.hostname, node.pairedAt);
}

export function setNodeName(id: string, name: string): void {
  getDb().query("UPDATE nodes SET name = ? WHERE id = ?").run(name, id);
}

/** Marks the node revoked at `at`, unless it already is (the first revocation's time stays). */
export function setNodeRevoked(id: string, at: string): void {
  getDb().query("UPDATE nodes SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(at, id);
}

/** Marks the node removed at `at`, unless it already is (the first removal's time stays). */
export function setNodeRemoved(id: string, at: string): void {
  getDb().query("UPDATE nodes SET removed_at = COALESCE(removed_at, ?) WHERE id = ?").run(at, id);
}

/** Returns the grant's ID. */
export function insertPairingGrant(grant: { codeSha256: string; name: string | null; createdAt: string; expiresAt: string }): number {
  return getDb().query<{ id: number }, [string, string | null, string, string]>("INSERT INTO node_pairing_grants (code_sha256, name, created_at, expires_at) VALUES (?, ?, ?, ?) RETURNING id")
    .get(grant.codeSha256, grant.name, grant.createdAt, grant.expiresAt)!.id;
}

/** Consumes the grant of the code hashing to `codeSha256` if it is unused and unexpired at `at`, returning
 * it; null otherwise. One conditional update: of competing consumers, exactly one gets the grant. */
export function consumePairingGrant(codeSha256: string, at: string): { id: number; name: string | null } | null {
  return getDb().query<{ id: number; name: string | null }, [string, string]>(`UPDATE node_pairing_grants SET consumed_at = ?1
    WHERE code_sha256 = ?2 AND consumed_at IS NULL AND expires_at > ?1 RETURNING id, name`).get(at, codeSha256) ?? null;
}

/** Records the node a consumed grant paired. */
export function setPairingGrantNode(id: number, nodeId: string): void {
  getDb().query("UPDATE node_pairing_grants SET node_id = ? WHERE id = ?").run(nodeId, id);
}
