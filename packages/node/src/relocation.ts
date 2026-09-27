import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { NodeResult } from "./contract.js";
import { piSnapshotSummary, samePiSnapshot, summarizePiSnapshot, writePiSnapshot, type PiSnapshotRow, type PiSnapshotSummary } from "./pi-storage.js";
import { nodeSessionBinding, provisionNodeSession, type NodeSessionBinding, type NodeSessionTask } from "./storage.js";
import type { SessionSnapshot } from "./protocol/schema.js";
import type { AttachmentBytes } from "./runtime/attachments.js";
import { APPLICATION_ERROR } from "./protocol/errors.js";
import { RpcFailure } from "./protocol/peer.js";

type NodeRejection = Extract<NodeResult, { ok: false }>["error"];
/** What relocation needs from the server connection; each call rejects when there is none. */
export interface RelocationServer {
  snapshot(sessionId: string, fromSeq: number): Promise<SessionSnapshot>;
  fetchAttachment(sessionId: string, attachmentId: string): Promise<AttachmentBytes | null>;
}
export interface HydrateRequest { sessionId: string; binding: NodeSessionBinding; task: NodeSessionTask | null; snapshot: PiSnapshotSummary }

const rejected = (code: NodeRejection["code"], message: string, retryable = false): NodeRejection => ({ code, message, retryable });
/** An explicit server rejection is definitive; a transport failure may succeed when the command is replayed. */
function serverFailure(error: unknown, what: string): NodeRejection {
  const message = `${what}: ${error instanceof Error ? error.message : String(error)}`;
  return error instanceof RpcFailure && error.code === APPLICATION_ERROR ? rejected("invalid_request", message) : rejected("unavailable", message, true);
}

type ImageRef = { attachmentId: string; mimeType?: unknown; byteSize?: unknown; sha256?: unknown };
/** Attachment references anywhere in the copied rows (prompt images, node-created tool-result images,
 * Pi's staged entries). Inline images carry their bytes and need nothing. */
function referencedAttachments(rows: readonly PiSnapshotRow[]): Map<string, ImageRef> {
  const found = new Map<string, ImageRef>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    if ("type" in value && value.type === "image" && "attachmentId" in value && typeof value.attachmentId === "string" && !("data" in value && typeof value.data === "string")) {
      if (!found.has(value.attachmentId)) found.set(value.attachmentId, value as ImageRef); // eslint-disable-line typescript-eslint/consistent-type-assertions -- narrowed above
    }
    for (const item of Object.values(value)) visit(item);
  };
  for (const row of rows) {
    const json = row.table === "entry" ? row.messageJson : row.table === "usage" ? null : row.valueJson;
    if (json?.includes("attachmentId")) visit(JSON.parse(json));
  }
  return found;
}

function verifyAttachment(ref: ImageRef, attachment: AttachmentBytes): string | null {
  if (attachment.byteSize !== attachment.data.byteLength) return `Attachment size mismatch: ${ref.attachmentId}`;
  if (createHash("sha256").update(attachment.data).digest("hex") !== attachment.sha256) return `Attachment checksum mismatch: ${ref.attachmentId}`;
  if ((typeof ref.sha256 === "string" && ref.sha256 !== attachment.sha256) || (typeof ref.mimeType === "string" && ref.mimeType !== attachment.mimeType)
    || (typeof ref.byteSize === "number" && ref.byteSize !== attachment.byteSize)) return `Attachment metadata mismatch: ${ref.attachmentId}`;
  return null;
}

/**
 * `session.hydrate` on the node. Converges by content: a node that already holds this session (a
 * replay after a lost acknowledgement, even after a node restart) answers at once when its copy
 * (binding and snapshot summary) is identical and rejects a different one. Otherwise it pulls the server's copy page by page and every attachment it references,
 * then in one transaction binds the session (with its task snapshot), writes the rows verbatim, caches
 * the attachments and recomputes the summary from what it stored; any mismatch
 * rolls everything back. Nothing is stored before that transaction, so a node that restarts or loses its
 * connection mid-pull starts over when the command is replayed. The caller serializes per session.
 */
export async function hydrateNodeSession(db: Database, server: RelocationServer, request: HydrateRequest): Promise<NodeRejection | null> {
  const { sessionId, snapshot } = request;
  const existing = nodeSessionBinding(db, sessionId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(request.binding) || !samePiSnapshot(piSnapshotSummary(db, sessionId), snapshot)) {
      return rejected("invalid_request", `Node already holds a different copy of session ${sessionId}`);
    }
    return null;
  }
  const rows: PiSnapshotRow[] = [];
  for (let from: number | null = 0; from !== null;) {
    let page: SessionSnapshot;
    try { page = await server.snapshot(sessionId, from); }
    catch (error) { return serverFailure(error, "Session snapshot failed"); }
    if (!samePiSnapshot(page.summary, snapshot)) return rejected("invalid_request", `Server copy of session ${sessionId} changed during hydration`);
    rows.push(...page.rows);
    from = page.nextSeq;
  }
  // Checked before writing so a short or reordered pull is reported as such.
  if (!samePiSnapshot(summarizePiSnapshot(snapshot.harnessNextSeq, rows), snapshot)) {
    return rejected("invalid_request", `Hydration verification failed for session ${sessionId}: pulled rows do not match the snapshot`);
  }
  const attachments: Array<[string, AttachmentBytes]> = [];
  for (const ref of referencedAttachments(rows).values()) {
    let attachment: AttachmentBytes | null;
    try { attachment = await server.fetchAttachment(sessionId, ref.attachmentId); }
    catch (error) { return serverFailure(error, "Attachment fetch failed"); }
    // Not held by the server (pruned): providers get the missing-image placeholder, as on the server.
    if (!attachment) continue;
    const invalid = verifyAttachment(ref, attachment);
    if (invalid) return rejected("invalid_request", invalid);
    attachments.push([ref.attachmentId, attachment]);
  }
  try {
    db.transaction(() => {
      provisionNodeSession(db, sessionId, request.binding, request.task);
      writePiSnapshot(db, sessionId, snapshot.harnessNextSeq, rows);
      for (const [attachmentId, attachment] of attachments) db.query(`INSERT INTO node_attachments(session_id,attachment_id,mime_type,byte_size,sha256,filename,width,height,data)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionId, attachmentId, attachment.mimeType, attachment.byteSize, attachment.sha256,
        attachment.filename ?? null, attachment.width ?? null, attachment.height ?? null, Buffer.from(attachment.data));
      if (!samePiSnapshot(piSnapshotSummary(db, sessionId), snapshot)) throw new Error(`Hydration verification failed for session ${sessionId}: stored copy does not match the snapshot`);
    })();
  } catch (error) {
    return rejected("invalid_request", error instanceof Error ? error.message : String(error));
  }
  return null;
}

/**
 * The storage half of `session.release`, once the caller closed the session's runtime and drained its
 * outbox: refuses while reports are still pending, confirms the server's copy matches the local one,
 * then deletes everything the node holds for the session (binding, Pi rows, outbox, attachment cache)
 * in one transaction. Nothing is kept: a replay finds no session and answers `not_found`, which the
 * server treats as released (its copy is all that is left, and it matched this one).
 */
export async function releaseNodeSession(db: Database, server: RelocationServer, sessionId: string): Promise<{ snapshot: PiSnapshotSummary } | NodeRejection> {
  if (db.query("SELECT 1 FROM session_outbox WHERE session_id = ? LIMIT 1").get(sessionId)) {
    return rejected("unavailable", `Session ${sessionId} still has reports the server has not acknowledged`, true);
  }
  const local = piSnapshotSummary(db, sessionId);
  let remote: SessionSnapshot;
  try { remote = await server.snapshot(sessionId, local.harnessNextSeq); }
  catch (error) { return serverFailure(error, "Session snapshot failed"); }
  if (!samePiSnapshot(remote.summary, local)) return rejected("internal", `Server copy of session ${sessionId} differs from the node's; release refused`);
  db.transaction(() => {
    for (const table of ["session_outbox", "node_attachments", "pi_usage", "pi_lists", "pi_values", "session_messages"]) {
      db.query(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
    }
    db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
  })();
  return { snapshot: local };
}
