import { getDb } from "../../db.js";
import type { RuntimeMessage } from "../../messages-store.js";

/** Store canonical AgentHarness entry fixtures without exercising a runtime. */
export function persistCanonicalMessages(sessionId: string, messages: RuntimeMessage[]): void {
  const db = getDb();
  const current = db.query<{ id: number; seq: number }, [string]>(
    "SELECT id, seq FROM session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
  ).get(sessionId);
  let parentId = current?.id ?? null;
  let seq = (current?.seq ?? -1) + 1;
  const insert = db.query<{ id: number }, [string, number, number | null, string, string, string]>(
    `INSERT INTO session_messages (session_id, seq, parent_id, harness_id, role, message_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING id`,
  );

  for (const [index, source] of messages.entries()) {
    const { logicalId, metadata: _metadata, ...message } = source;
    const harnessId = logicalId ?? `fixture-${sessionId}-${seq}-${index}`;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : seq;
    const entry = message.role === "compactionSummary"
      ? { type: "compaction", summary: message.summary ?? "", retainedTail: [], tokensBefore: 0, fromHook: false, timestamp }
      : {
          type: "message",
          timestamp,
          message: message.role === "user"
            ? { role: "reinsInput", content: message.content ?? [], reinsId: harnessId, metadata: {}, timestamp }
            : { ...message, timestamp },
        };
    const role = entry.type === "message" && entry.message ? entry.message.role : entry.type;
    const row = insert.get(sessionId, seq, parentId, harnessId, role, JSON.stringify(entry));
    if (!row) throw new Error("Failed to store canonical fixture entry");
    parentId = row.id;
    seq++;
  }

  const tip = db.query<{ harness_id: string | null }, [string]>(
    "SELECT harness_id FROM session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
  ).get(sessionId)?.harness_id ?? null;
  db.query(
    `INSERT INTO pi_values (session_id, namespace, key, seq, value_json)
     VALUES (?, 'pi.branch.tip', 'main', ?, ?)
     ON CONFLICT(session_id, namespace, key) DO UPDATE SET seq = excluded.seq, value_json = excluded.value_json`,
  ).run(sessionId, seq, JSON.stringify(tip));
  db.query("UPDATE sessions SET harness_next_seq = MAX(harness_next_seq, ?) WHERE id = ?").run(seq + 1, sessionId);
}
