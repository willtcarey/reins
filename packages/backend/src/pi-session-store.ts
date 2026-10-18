/**
 * Admission proof in a session's Pi storage: waits (`waitForSettlement`) tell an input Pi admitted from
 * one it never did.
 */
import { pendingEntry } from "@earendil-works/pi-agent-core";
import { getDb } from "./app-globals.js";

const PENDING_ENTRY_NAMESPACE = pendingEntry("").namespace;
/**
 * Proof of admission from the session's storage: Pi admits a prompt/steer durably as a `reinsInput` keyed
 * by `reinsId` (= the submission's clientId), either as a transcript entry (`{seq}`) or still queued as a
 * pending steering entry (`{queued: true}`; Pi moves it into the transcript in one commit). The runtime
 * acknowledges a submission once Pi committed it, so an acknowledged input is in storage. Null: the
 * input is not stored (never admitted, failed, or a queued steer an abort discarded).
 */
export function storedInput(sessionId: string, reinsId: string): { seq: number } | { queued: true } | null {
  const db = getDb();
  const entry = db.query<{ seq: number }, [string, string]>(`SELECT seq FROM session_messages WHERE session_id = ? AND role = 'reinsInput'
    AND json_valid(message_json) AND json_extract(message_json, '$.message.reinsId') = ? LIMIT 1`).get(sessionId, reinsId);
  if (entry) return { seq: entry.seq };
  return db.query(`SELECT 1 FROM pi_values WHERE session_id = ? AND namespace = ?
    AND json_extract(value_json, '$.payload.role') = 'reinsInput' AND json_extract(value_json, '$.payload.reinsId') = ? LIMIT 1`)
    .get(sessionId, PENDING_ENTRY_NAMESPACE, reinsId) ? { queued: true } : null;
}
