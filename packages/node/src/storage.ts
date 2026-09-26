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

export type NodeCommitDelivery = (sessionId: string, startSeq: number, writesJson: string) => Promise<void> | void;
const deliveries = new WeakMap<Database, Map<string, Promise<void>>>();
/** Per-session serial drain; only an awaited successful server acknowledgement deletes a batch. */
export function deliverNodeCommits(node: Database, sessionId: string, deliver: NodeCommitDelivery): Promise<void> {
  let sessions = deliveries.get(node);
  if (!sessions) { sessions = new Map(); deliveries.set(node, sessions); }
  const queue = sessions;
  const previous = queue.get(sessionId);
  const run = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    const rows = node.query<{ start_seq: number; writes_json: string }, [string]>(
      "SELECT start_seq, writes_json FROM pending_commits WHERE session_id = ? ORDER BY start_seq",
    ).all(sessionId);
    for (const row of rows) {
      await deliver(sessionId, row.start_seq, row.writes_json);
      node.query("DELETE FROM pending_commits WHERE session_id = ? AND start_seq = ? AND writes_json = ?")
        .run(sessionId, row.start_seq, row.writes_json);
    }
  });
  queue.set(sessionId, run);
  void run.finally(() => { if (queue.get(sessionId) === run) queue.delete(sessionId); }).catch(() => undefined);
  return run;
}

export async function openNodeStorage(node: Database, sessionId: string, deliver: NodeCommitDelivery, now: () => number = Date.now): Promise<PiStorageAdapter> {
  if (!nodeSessionBinding(node, sessionId)) throw new Error(`Node session not provisioned: ${sessionId}`);
  // Server unavailability cannot invalidate the node's already durable Pi commits.
  await deliverNodeCommits(node, sessionId, deliver).catch(() => undefined);
  return new PiStorageAdapter(node, sessionId, now, {
    record: (startSeq: number, writes: CommittedWrite[]) => node.query(
      "INSERT INTO pending_commits(session_id,start_seq,writes_json) VALUES(?,?,?)",
    ).run(sessionId, startSeq, JSON.stringify(writes)),
    deliver: () => deliverNodeCommits(node, sessionId, deliver),
  });
}
