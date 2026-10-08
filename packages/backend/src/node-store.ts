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

/** A node with its pairing: `paired` once it redeemed a pairing code with its public key (the seeded
 * local node never did), `revokedAt` once it was revoked. */
export interface NodeDetails extends NodeInfo { paired: boolean; hostname: string | null; pairedAt: string | null; revokedAt: string | null }

const NODE_DETAILS = `SELECT id, name, public_key IS NOT NULL AS paired, hostname, paired_at AS pairedAt, revoked_at AS revokedAt FROM nodes`;
const nodeDetails = ({ paired, ...node }: Omit<NodeDetails, "paired"> & { paired: number }): NodeDetails => ({ ...node, paired: paired === 1 });

/** Every node, in name order. */
export function listNodes(): NodeInfo[] {
  return getDb().query<NodeInfo, []>("SELECT id, name FROM nodes ORDER BY name, id").all();
}

/** Every node with its pairing, in name order. */
export function listNodeDetails(): NodeDetails[] {
  return getDb().query<Omit<NodeDetails, "paired"> & { paired: number }, []>(`${NODE_DETAILS} ORDER BY name, id`).all().map(nodeDetails);
}

export function getNode(id: string): NodeInfo | null {
  return getDb().query<NodeInfo, [string]>("SELECT id, name FROM nodes WHERE id = ?").get(id) ?? null;
}

export function getNodeDetails(id: string): NodeDetails | null {
  const node = getDb().query<Omit<NodeDetails, "paired"> & { paired: number }, [string]>(`${NODE_DETAILS} WHERE id = ?`).get(id);
  return node ? nodeDetails(node) : null;
}

/** The public key a connection claiming to be node `nodeId` must prove it holds: that of a paired,
 * unrevoked node, else null. */
export function activeNodeKey(nodeId: string): string | null {
  return getDb().query<{ public_key: string }, [string]>("SELECT public_key FROM nodes WHERE id = ? AND public_key IS NOT NULL AND revoked_at IS NULL").get(nodeId)?.public_key ?? null;
}

/** Throws a UNIQUE constraint error when another node already holds `publicKey`. */
export function insertPairedNode(node: { id: string; name: string; publicKey: string; hostname: string; pairedAt: string }): void {
  getDb().query("INSERT INTO nodes (id, name, public_key, hostname, paired_at) VALUES (?, ?, ?, ?, ?)")
    .run(node.id, node.name, node.publicKey, node.hostname, node.pairedAt);
}

/** Marks the node revoked at `at`, unless it already is (the first revocation's time stays). */
export function setNodeRevoked(id: string, at: string): void {
  getDb().query("UPDATE nodes SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(at, id);
}

export function insertPairingGrant(grant: { codeSha256: string; name: string | null; createdAt: string; expiresAt: string }): void {
  getDb().query("INSERT INTO node_pairing_grants (code_sha256, name, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(grant.codeSha256, grant.name, grant.createdAt, grant.expiresAt);
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
