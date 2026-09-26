import type { Database } from "bun:sqlite";
import type { CommittedWrite } from "@earendil-works/pi-agent-core";
import { PiStorageAdapter } from "@reins/node/pi-storage";

/** Apply node-committed writes to the server's readable replica, idempotently. */
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

/** Records a node run lifecycle report inside the caller's transaction, so the receipt commits with
 * its effects. True the first time; false for an identical replay (apply nothing); a different
 * payload for the same (session, run, kind) is divergence and throws, leaving the report pending. */
export function recordNodeLifecycle(server: Database, sessionId: string, runId: string, kind: "started" | "settled", payloadJson: string): boolean {
  const receipt = server.query<{ payload_json: string }, [string, string, string]>(
    "SELECT payload_json FROM node_lifecycle_receipts WHERE session_id = ? AND run_id = ? AND kind = ?",
  ).get(sessionId, runId, kind);
  if (receipt) {
    if (receipt.payload_json !== payloadJson) throw new Error(`Lifecycle divergence: ${sessionId} ${kind} ${runId}`);
    return false;
  }
  server.query("INSERT INTO node_lifecycle_receipts(session_id,run_id,kind,payload_json) VALUES(?,?,?,?)")
    .run(sessionId, runId, kind, payloadJson);
  return true;
}
