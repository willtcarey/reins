import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CommittedWrite } from "@earendil-works/pi-agent-core";
import { PiStorageAdapter } from "./pi-storage.js";
import { runNodeMigrations } from "./migrations.js";
import type { SessionConfiguration } from "./contract.js";
import type { AttachmentStore } from "./protocol/schema.js";
import { referenceInlineImages } from "./runtime/tool-images.js";

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

/** The task snapshot a session was provisioned with; null for a scratch session. */
export type NodeSessionTask = NonNullable<SessionConfiguration["task"]>;

/** Step 1 of provision: stores the session's immutable binding and, on first bind, its task snapshot.
 * A repeat with an equal binding changes nothing (the first provision's task stands); a different
 * binding rejects. */
export function provisionNodeSession(db: Database, sessionId: string, binding: NodeSessionBinding, task: NodeSessionTask | null): void {
  db.transaction(() => {
    const existing = nodeSessionBinding(db, sessionId);
    bindNodeSession(db, sessionId, binding);
    if (existing || !task) return;
    db.query("UPDATE sessions SET task_json = ? WHERE id = ?").run(JSON.stringify(task), sessionId);
  })();
}

export function nodeSessionTask(db: Database, sessionId: string): NodeSessionTask | null {
  const row = db.query<{ task_json: string | null }, [string]>("SELECT task_json FROM sessions WHERE id = ?").get(sessionId);
  if (!row) throw new Error(`Node session not provisioned: ${sessionId}`);
  return row.task_json ? JSON.parse(row.task_json) : null;
}

export function nodeSessionBinding(db: Database, sessionId: string): NodeSessionBinding | null {
  const row = db.query<{ source_id: number; cwd: string; created_at: string; parent_session_id: string | null }, [string]>(
    "SELECT source_id,cwd,created_at,parent_session_id FROM sessions WHERE id = ?",
  ).get(sessionId);
  return row ? { sourceId: row.source_id, cwd: row.cwd, createdAt: row.created_at, parentSessionId: row.parent_session_id } : null;
}

export function pendingOutboxSessions(db: Database): string[] {
  return db.query<{ session_id: string }, []>("SELECT DISTINCT session_id FROM session_outbox").all().map(row => row.session_id);
}

/** A node-created attachment to upload under its node-assigned ID, read from `node_attachments` at delivery. */
export type NodeAttachmentUpload = Omit<AttachmentStore, "sessionId"> & { data: Uint8Array };
/** A durable node→server report. Commits carry `writesJson` byte-for-byte; lifecycle payloads are the report
 * JSON without sessionId; an attachment upload carries the cached bytes it names. */
export type NodeOutboxItem = { kind: "committed"; startSeq: number; payload: string } | { kind: "started" | "settled"; payload: string }
  | { kind: "attachment"; attachment: NodeAttachmentUpload };
export type NodeOutboxDelivery = (sessionId: string, item: NodeOutboxItem) => Promise<void> | void;
type OutboxRow = { id: number; kind: NodeOutboxItem["kind"]; start_seq: number | null; payload: string; ready: number };
type CachedUpload = { mime_type: string; byte_size: number; sha256: string; filename: string | null; width: number | null; height: number | null; data: Uint8Array };

function attachmentUpload(db: Database, sessionId: string, payload: string): NodeAttachmentUpload {
  const { attachmentId }: { attachmentId: string } = JSON.parse(payload);
  const row = db.query<CachedUpload, [string, string]>(
    "SELECT mime_type,byte_size,sha256,filename,width,height,data FROM node_attachments WHERE session_id = ? AND attachment_id = ?",
  ).get(sessionId, attachmentId);
  // The row is written with its upload item and removed only with the session, so this is corruption.
  if (!row) throw new Error(`Node attachment missing for upload: ${attachmentId}`);
  return { attachmentId, mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256,
    ...(row.filename !== null ? { filename: row.filename } : {}),
    ...(row.width !== null && row.height !== null ? { width: row.width, height: row.height } : {}), data: new Uint8Array(row.data) };
}
function outboxItem(db: Database, sessionId: string, row: OutboxRow): NodeOutboxItem {
  if (row.kind === "committed") return { kind: row.kind, startSeq: row.start_seq!, payload: row.payload };
  if (row.kind === "attachment") return { kind: row.kind, attachment: attachmentUpload(db, sessionId, row.payload) };
  return { kind: row.kind, payload: row.payload };
}

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
      await deliver(sessionId, outboxItem(node, sessionId, row));
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
    // Safety net for results Pi commits without the `after_tool` hook (a checkpointed result republished
    // on recovery, a hook cut short by abort): inline images become references in the same transaction,
    // their upload rows ahead of this commit's row.
    prepare: writes => referenceInlineImages(node, sessionId, writes),
    // Inside the Pi commit transaction, so a later lifecycle report is always ordered after it.
    record: (startSeq: number, writes: CommittedWrite[]) => node.query(
      "INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES(?,'committed',?,?)",
    ).run(sessionId, startSeq, JSON.stringify(writes)),
    deliver: () => deliverNodeOutbox(node, sessionId, deliver),
  });
}
