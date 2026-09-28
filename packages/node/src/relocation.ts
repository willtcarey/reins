import type { Database } from "bun:sqlite";
import { piSnapshotSummary, samePiSnapshot, summarizePiSnapshot, writePiSnapshot, type PiSnapshotRow, type PiSnapshotSummary } from "@reins/pi-sql-storage";
import { nodeSessionBinding, provisionNodeSession, type NodeSessionTask } from "./storage.js";
import { NodeRejection, serverCallRejection, type NodeSessionBinding, type SessionSnapshot } from "@reins/node-protocol";
import { attachmentMismatch, cacheAttachment, type AttachmentBytes } from "./node-attachments.js";

/** What relocation needs from the server connection. */
export interface RelocationServer {
  snapshot(sessionId: string, fromSeq: number): Promise<SessionSnapshot>;
  fetchAttachment(sessionId: string, attachmentId: string): Promise<AttachmentBytes | null>;
}
export interface HydrateRequest { sessionId: string; binding: NodeSessionBinding; task: NodeSessionTask | null; snapshot: PiSnapshotSummary }

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

/** Whether the node already holds exactly the copy a hydrate carries (same binding and snapshot
 * summary): a replay after a lost acknowledgement, even after a node restart, is answered at once. */
export function holdsHydratedCopy(db: Database, request: HydrateRequest): boolean {
  const existing = nodeSessionBinding(db, request.sessionId);
  return !!existing && JSON.stringify(existing) === JSON.stringify(request.binding) && samePiSnapshot(piSnapshotSummary(db, request.sessionId), request.snapshot);
}

/**
 * `session.hydrate` on the node, once the caller answered an identical copy (`holdsHydratedCopy`) and
 * dropped any other copy it held (`dropNodeSession`). Pulls the server's copy page by page and every
 * attachment it references, then in one transaction binds the session (with its task snapshot), writes
 * the rows verbatim, caches the attachments and recomputes the summary from what it stored; any mismatch
 * rolls everything back (every failure throws a `NodeRejection`). Nothing is stored before that
 * transaction, so a node that restarts or loses its connection mid-pull starts over when the command is
 * replayed. `server` is the current connection (it throws when there is none). The caller serializes
 * per session.
 */
export async function hydrateNodeSession(db: Database, server: () => RelocationServer, request: HydrateRequest): Promise<void> {
  const { sessionId, snapshot } = request;
  const rows: PiSnapshotRow[] = [];
  for (let from: number | null = 0; from !== null;) {
    let page: SessionSnapshot;
    try { page = await server().snapshot(sessionId, from); }
    catch (error) { throw serverCallRejection(error, "Session snapshot failed"); }
    if (!samePiSnapshot(page.summary, snapshot)) throw new NodeRejection("invalid_request", `Server copy of session ${sessionId} changed during hydration`);
    rows.push(...page.rows);
    from = page.nextSeq;
  }
  // Checked before writing so a short or reordered pull is reported as such.
  if (!samePiSnapshot(summarizePiSnapshot(snapshot.harnessNextSeq, rows), snapshot)) {
    throw new NodeRejection("invalid_request", `Hydration verification failed for session ${sessionId}: pulled rows do not match the snapshot`);
  }
  const attachments: Array<[string, AttachmentBytes]> = [];
  for (const ref of referencedAttachments(rows).values()) {
    let attachment: AttachmentBytes | null;
    try { attachment = await server().fetchAttachment(sessionId, ref.attachmentId); }
    catch (error) { throw serverCallRejection(error, "Attachment fetch failed"); }
    // Not held by the server (pruned): providers get the missing-image placeholder, as on the server.
    if (!attachment) continue;
    const invalid = attachmentMismatch(ref, attachment, true);
    if (invalid) throw new NodeRejection("invalid_request", invalid);
    attachments.push([ref.attachmentId, attachment]);
  }
  try {
    db.transaction(() => {
      provisionNodeSession(db, sessionId, request.binding, request.task);
      writePiSnapshot(db, sessionId, snapshot.harnessNextSeq, rows);
      for (const [attachmentId, attachment] of attachments) cacheAttachment(db, sessionId, attachmentId, attachment);
      if (!samePiSnapshot(piSnapshotSummary(db, sessionId), snapshot)) throw new Error(`Hydration verification failed for session ${sessionId}: stored copy does not match the snapshot`);
    })();
  } catch (error) {
    throw new NodeRejection("invalid_request", error instanceof Error ? error.message : String(error));
  }
}
