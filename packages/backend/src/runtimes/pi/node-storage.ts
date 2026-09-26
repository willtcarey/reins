import type { Database } from "bun:sqlite";
import type { CommittedWrite } from "@earendil-works/pi-agent-core";
import { resolveDataDir, hasInjectedDb } from "../../db.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getNodeDb as nodeDatabase, hasNodeDb, openNodeStorage as openStorage, deliverNodeCommits as drain,
} from "@reins/node/storage";
export function getNodeDb(): Database {
  if (hasNodeDb()) return nodeDatabase();
  if (hasInjectedDb()) throw new Error("Node database must be injected when the server DB is injected");
  const legacyPath = join(resolveDataDir(), "internal-node.db");
  if (existsSync(legacyPath)) throw new Error(`Legacy node database at ${legacyPath}; migrate it offline before opening node storage`);
  return nodeDatabase();
}

/** Server-owned exact read-replica application and receipt; node owns outbox acknowledgement. */
export function applyNodeReplica(server: Database, sessionId: string, startSeq: number, writesJson: string): void {
  server.transaction(() => {
    const receipt = server.query<{ writes_json: string }, [string, number]>(
      "SELECT writes_json FROM node_replica_receipts WHERE session_id = ? AND start_seq = ?",
    ).get(sessionId, startSeq);
    if (receipt) {
      if (receipt.writes_json !== writesJson) throw new Error(`Replica divergence: ${sessionId}`);
      return;
    }
    const writes: CommittedWrite[] = JSON.parse(writesJson);
    new PiStorageAdapter(server, sessionId).applyReplicaWrites(startSeq, writes);
    server.query("INSERT INTO node_replica_receipts(session_id,start_seq,writes_json) VALUES(?,?,?)")
      .run(sessionId, startSeq, writesJson);
  })();
}

import { PiStorageAdapter } from "@reins/node/pi-storage";
export function deliverNodeCommits(node: Database, server: Database, sessionId: string): Promise<void> {
  return drain(node, sessionId, (id, seq, json) => applyNodeReplica(server, id, seq, json));
}
export function openNodeStorage(node: Database, server: Database, sessionId: string, now: () => number = Date.now): Promise<PiStorageAdapter> {
  return openStorage(node, sessionId, (id, seq, json) => applyNodeReplica(server, id, seq, json), now);
}
