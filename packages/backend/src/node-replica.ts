import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { pendingEntry, type CommittedWrite } from "@earendil-works/pi-agent-core";
import { PiStorageAdapter } from "@reins/node/pi-storage";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

interface Watermark {
  commit_start_seq: number | null; commit_sha256: string | null;
  report_run_id: string | null; report_kind: "started" | "settled" | null; report_sha256: string | null;
  settlement_count: number; settlement_json: string | null; settlement_next_seq: number | null;
}
function watermark(server: Database, sessionId: string): Watermark | null {
  return server.query<Watermark, [string]>(`SELECT commit_start_seq, commit_sha256, report_run_id, report_kind, report_sha256,
    settlement_count, settlement_json, settlement_next_seq FROM node_session_watermarks WHERE session_id = ?`).get(sessionId);
}
function ensureWatermark(server: Database, sessionId: string): void {
  server.query("INSERT INTO node_session_watermarks(session_id) VALUES(?) ON CONFLICT(session_id) DO NOTHING").run(sessionId);
}

/**
 * Apply a node-committed batch to the server's readable replica, idempotently, by sequence watermark.
 * A batch covers seqs `[startSeq, startSeq + writes.length)`; the node records batches contiguously
 * from its `harness_next_seq`, so they never partially overlap. Against the server's `harness_next_seq`:
 * `startSeq` equal applies it (and remembers its start and hash); greater is a gap and rejects (the
 * batch stays pending on the node); smaller is a replay of an applied batch and is acknowledged
 * without applying. A replay of the last applied batch is compared by hash (a different string is
 * divergence and rejects); an older replay cannot be checked and is acknowledged. A batch that
 * straddles the watermark cannot come from the node's own history and rejects as divergence.
 */
export function applyNodeReplica(server: Database, sessionId: string, startSeq: number, writesJson: string): void {
  server.transaction(() => {
    const session = server.query<{ harness_next_seq: number }, [string]>("SELECT harness_next_seq FROM sessions WHERE id = ?").get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const next = session.harness_next_seq;
    const writes: CommittedWrite[] = JSON.parse(writesJson);
    if (!writes.length) throw new Error(`Empty replica batch: ${sessionId}@${startSeq}`);
    if (startSeq > next) throw new Error(`Replica gap: ${sessionId} expects seq ${next}, got ${startSeq}`);
    if (startSeq < next) {
      if (startSeq + writes.length > next) throw new Error(`Replica divergence: ${sessionId} batch at ${startSeq} overlaps seq ${next}`);
      const last = watermark(server, sessionId);
      if (last?.commit_start_seq === startSeq && last.commit_sha256 !== sha256(writesJson)) throw new Error(`Replica divergence: ${sessionId}`);
      return;
    }
    new PiStorageAdapter(server, sessionId).applyReplicaWrites(startSeq, writes);
    ensureWatermark(server, sessionId);
    server.query("UPDATE node_session_watermarks SET commit_start_seq = ?, commit_sha256 = ? WHERE session_id = ?")
      .run(startSeq, sha256(writesJson), sessionId);
  })();
}

/**
 * Records a node run lifecycle report inside the caller's transaction, so the watermark commits with
 * its effects. The node delivers a session's reports in order and deletes each only after its
 * acknowledgement, so the only report that can be replayed is the last one applied: the watermark is
 * that report's `(runId, kind)` and payload hash. True means apply; false means an already applied
 * report (apply nothing): the last report again, or a `started` for the run that last settled (Pi
 * re-emits `started` for a resumed run). The same key with a different payload is divergence and
 * throws, leaving the report pending. Settlements also count up and keep their outcome and the
 * replica's `harness_next_seq` for waits: the node delivers a run's commits before its settlement, so
 * every replica entry below that seq was committed before the run settled.
 */
export function recordNodeLifecycle(server: Database, sessionId: string, runId: string, kind: "started" | "settled", payloadJson: string): boolean {
  const last = watermark(server, sessionId);
  const hash = sha256(payloadJson);
  if (last?.report_run_id === runId) {
    if (last.report_kind === kind) {
      if (last.report_sha256 !== hash) throw new Error(`Lifecycle divergence: ${sessionId} ${kind} ${runId}`);
      return false;
    }
    if (kind === "started") return false;
  }
  ensureWatermark(server, sessionId);
  server.query("UPDATE node_session_watermarks SET report_run_id = ?, report_kind = ?, report_sha256 = ? WHERE session_id = ?")
    .run(runId, kind, hash, sessionId);
  if (kind === "settled") {
    const { status, error }: Omit<NodeSettlement, "seq"> = JSON.parse(payloadJson);
    server.query(`UPDATE node_session_watermarks SET settlement_count = settlement_count + 1, settlement_json = ?,
      settlement_next_seq = (SELECT harness_next_seq FROM sessions WHERE id = ?) WHERE session_id = ?`)
      .run(JSON.stringify({ status, ...(error ? { error } : {}) }), sessionId, sessionId);
  }
  return true;
}

/** The session's most recently applied node settlement: `seq` counts applied settlements, so a caller
 * can tell whether a settlement arrived after an earlier observation; `nextSeq` is the replica's
 * `harness_next_seq` when it was applied (entries below it were committed before it). */
export function latestNodeSettlement(server: Database, sessionId: string): NodeSettlement | null {
  const row = watermark(server, sessionId);
  if (!row?.settlement_json) return null;
  const report: Omit<NodeSettlement, "seq" | "nextSeq"> = JSON.parse(row.settlement_json);
  return { seq: row.settlement_count, nextSeq: row.settlement_next_seq ?? 0, status: report.status, ...(report.error ? { error: report.error } : {}) };
}
export interface NodeSettlement { seq: number; nextSeq: number; status: "completed" | "failed" | "aborted"; error?: { code?: string; message: string } }

const PENDING_ENTRY_NAMESPACE = pendingEntry("").namespace;
/**
 * Proof of admission from the replica: Pi admits a prompt/steer durably as a `reinsInput` keyed by
 * `reinsId` (= the command's clientId), either as a transcript entry (`{seq}`) or still queued as a
 * pending steering entry (`{queued: true}`; Pi moves it into the transcript in one commit). The node
 * delivers that commit before it answers the command, so an admitted input is normally in the replica
 * by the time its outbox row is settled. Null: the input is not in the replica (never admitted, failed,
 * or a queued steer an abort discarded).
 */
export function replicaInput(server: Database, sessionId: string, reinsId: string): { seq: number } | { queued: true } | null {
  const entry = server.query<{ seq: number }, [string, string]>(`SELECT seq FROM session_messages WHERE session_id = ? AND role = 'reinsInput'
    AND json_valid(message_json) AND json_extract(message_json, '$.message.reinsId') = ? LIMIT 1`).get(sessionId, reinsId);
  if (entry) return { seq: entry.seq };
  return server.query(`SELECT 1 FROM pi_values WHERE session_id = ? AND namespace = ?
    AND json_extract(value_json, '$.payload.role') = 'reinsInput' AND json_extract(value_json, '$.payload.reinsId') = ? LIMIT 1`)
    .get(sessionId, PENDING_ENTRY_NAMESPACE, reinsId) ? { queued: true } : null;
}
