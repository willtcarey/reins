import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CommittedWrite } from "@earendil-works/pi-agent-core";
import { PiStorageAdapter } from "./pi-storage.js";
import { runNodeMigrations } from "./migrations.js";

export interface NodeSessionBinding {
  sourceId: number;
  cwd: string;
  createdAt: string;
  parentSessionId: string | null;
}

export function initializeNodeStorage(db: Database): void {
  runNodeMigrations(db);
}

export function nodeStoragePath(home: string = homedir()): string {
  return join(home, ".reins", "node", "storage.db");
}

let nodeDb: Database | undefined;
/** A caller-owned test connection is never closed by the module. */
export function setNodeDb(db?: Database): void { nodeDb = db; }
export function hasNodeDb(): boolean { return nodeDb !== undefined; }
export function closeNodeDb(): void { nodeDb?.close(); nodeDb = undefined; }
export function getNodeDb(): Database {
  if (!nodeDb) {
    const path = nodeStoragePath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new Database(path);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      initializeNodeStorage(db);
      nodeDb = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  return nodeDb;
}

export function bindNodeSession(db: Database, sessionId: string, binding: NodeSessionBinding): void {
  const row = nodeSessionBinding(db, sessionId);
  if (row) {
    if (JSON.stringify(row) !== JSON.stringify(binding)) throw new Error(`Node session binding mismatch: ${sessionId}`);
    return;
  }
  db.query("INSERT INTO sessions(id,source_id,cwd,created_at,parent_session_id) VALUES(?,?,?,?,?)")
    .run(sessionId, binding.sourceId, binding.cwd, binding.createdAt, binding.parentSessionId);
}

export function nodeSessionBinding(db: Database, sessionId: string): NodeSessionBinding | null {
  const row = db.query<{ source_id: number; cwd: string; created_at: string; parent_session_id: string | null }, [string]>(
    "SELECT source_id,cwd,created_at,parent_session_id FROM sessions WHERE id = ?",
  ).get(sessionId);
  return row ? { sourceId: row.source_id, cwd: row.cwd, createdAt: row.created_at, parentSessionId: row.parent_session_id } : null;
}

export interface NodeAdmissionReceipt { sessionId: string; operation: string; payload: string }
export function nodeAdmissionReceipt(db: Database, commandId: string): NodeAdmissionReceipt | null {
  const row = db.query<{ session_id: string; operation: string; payload: string }, [string]>(
    "SELECT session_id, operation, payload FROM admission_receipts WHERE command_id = ?",
  ).get(commandId);
  return row ? { sessionId: row.session_id, operation: row.operation, payload: row.payload } : null;
}

/** Caller controls the admission action. Atomicity is guaranteed only if it writes on this same SQLite connection synchronously. */
export function recordNodeAdmission(db: Database, commandId: string, sessionId: string, operation: string, payload: string, admit: () => void): void {
  db.transaction(() => {
    const prior = nodeAdmissionReceipt(db, commandId);
    if (prior) {
      if (prior.sessionId !== sessionId || prior.operation !== operation || prior.payload !== payload) throw new Error(`Node admission receipt mismatch: ${commandId}`);
      return;
    }
    admit();
    db.query("INSERT INTO admission_receipts(command_id,session_id,operation,payload) VALUES(?,?,?,?)")
      .run(commandId, sessionId, operation, payload);
  })();
}

export function pendingOutboxSessions(db: Database): string[] {
  return db.query<{ session_id: string }, []>("SELECT DISTINCT session_id FROM session_outbox").all().map(row => row.session_id);
}

/** A durable node→server report. Commits carry `writesJson` byte-for-byte; lifecycle payloads are the report JSON without sessionId. */
export type NodeOutboxItem = { kind: "committed"; startSeq: number; payload: string } | { kind: "started" | "settled"; payload: string };
export type NodeOutboxDelivery = (sessionId: string, item: NodeOutboxItem) => Promise<void> | void;
type OutboxRow = { id: number; kind: NodeOutboxItem["kind"]; start_seq: number | null; payload: string; ready: number };

/** Appends a lifecycle report after everything already recorded for its session. An unready report
 * blocks later ones until `completeNodeReport`. Returns the row ID. */
export function recordNodeReport(db: Database, sessionId: string, kind: "started" | "settled", payload: string, ready = true): number {
  return Number(db.query("INSERT INTO session_outbox(session_id,kind,payload,ready) VALUES(?,?,?,?)")
    .run(sessionId, kind, payload, ready ? 1 : 0).lastInsertRowid);
}
export function completeNodeReport(db: Database, id: number, payload: string): void {
  db.query("UPDATE session_outbox SET payload = ?, ready = 1 WHERE id = ? AND ready = 0").run(payload, id);
}
/** At node start, no reply read is in flight: release held settlements as reply-unavailable. */
export function releaseUnreadReports(db: Database, replyError: string): void {
  db.query("UPDATE session_outbox SET payload = json_set(payload, '$.replyError', ?), ready = 1 WHERE ready = 0").run(replyError);
}

const deliveries = new WeakMap<Database, Map<string, Promise<void>>>();
/** Per-session serial drain in record order; only an awaited successful server acknowledgement
 * deletes a report, and an unready report stops the drain. */
export function deliverNodeOutbox(node: Database, sessionId: string, deliver: NodeOutboxDelivery): Promise<void> {
  let sessions = deliveries.get(node);
  if (!sessions) { sessions = new Map(); deliveries.set(node, sessions); }
  const queue = sessions;
  const previous = queue.get(sessionId);
  const run = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    const rows = node.query<OutboxRow, [string]>(
      "SELECT id, kind, start_seq, payload, ready FROM session_outbox WHERE session_id = ? ORDER BY id",
    ).all(sessionId);
    for (const row of rows) {
      if (!row.ready) return;
      await deliver(sessionId, row.kind === "committed" ? { kind: row.kind, startSeq: row.start_seq!, payload: row.payload } : { kind: row.kind, payload: row.payload });
      node.query("DELETE FROM session_outbox WHERE id = ?").run(row.id);
    }
  });
  queue.set(sessionId, run);
  void run.finally(() => { if (queue.get(sessionId) === run) queue.delete(sessionId); }).catch(() => undefined);
  return run;
}

export async function openNodeStorage(node: Database, sessionId: string, deliver: NodeOutboxDelivery, now: () => number = Date.now): Promise<PiStorageAdapter> {
  if (!nodeSessionBinding(node, sessionId)) throw new Error(`Node session not provisioned: ${sessionId}`);
  // Server unavailability cannot invalidate the node's already durable Pi commits.
  await deliverNodeOutbox(node, sessionId, deliver).catch(() => undefined);
  return new PiStorageAdapter(node, sessionId, now, {
    // Inside the Pi commit transaction, so a later lifecycle report is always ordered after it.
    record: (startSeq: number, writes: CommittedWrite[]) => node.query(
      "INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES(?,'committed',?,?)",
    ).run(sessionId, startSeq, JSON.stringify(writes)),
    deliver: () => deliverNodeOutbox(node, sessionId, deliver),
  });
}
