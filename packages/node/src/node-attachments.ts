import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { ClientPromptContent } from "./runtime/types.js";
import { NodeRejection } from "@reins/node-protocol";

/** Attachment bytes with their metadata, as the server serves them and `node_attachments` caches them. */
export interface AttachmentBytes {
  data: Uint8Array;
  mimeType: string;
  byteSize: number;
  sha256: string;
  filename?: string;
  width?: number;
  height?: number;
}
export type FetchAttachment = (sessionId: string, attachmentId: string) => Promise<AttachmentBytes | null>;
/** What a stored reference declares about its attachment; undeclared fields are not checked. */
type AttachmentRef = { attachmentId: string; mimeType?: unknown; byteSize?: unknown; sha256?: unknown };
type ImageRef = Extract<ClientPromptContent[number], { type: "image" }>;
type CachedRow = { mime_type: string; byte_size: number; sha256: string; filename: string | null; width: number | null; height: number | null; data: Uint8Array };

/** The session's cached attachment, or null. */
export function readCachedAttachment(db: Database, sessionId: string, attachmentId: string): AttachmentBytes | null {
  const row = db.query<CachedRow, [string, string]>(
    "SELECT mime_type,byte_size,sha256,filename,width,height,data FROM node_attachments WHERE session_id=? AND attachment_id=?",
  ).get(sessionId, attachmentId);
  if (!row) return null;
  return { mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256,
    ...(row.filename !== null ? { filename: row.filename } : {}),
    ...(row.width !== null && row.height !== null ? { width: row.width, height: row.height } : {}), data: new Uint8Array(row.data) };
}

/** Caches `attachment` under `attachmentId` unless the session already holds that ID; returns whether it was written. */
export function cacheAttachment(db: Database, sessionId: string, attachmentId: string, attachment: AttachmentBytes): boolean {
  return db.query(`INSERT OR IGNORE INTO node_attachments(session_id,attachment_id,mime_type,byte_size,sha256,filename,width,height,data)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionId, attachmentId, attachment.mimeType, attachment.byteSize, attachment.sha256,
    attachment.filename ?? null, attachment.width ?? null, attachment.height ?? null, Buffer.from(attachment.data)).changes > 0;
}

/** Why `attachment` does not match `ref`, or null. Bytes (size, then checksum) are checked only when
 * `checkBytes` (bytes from the server; cached bytes were checked when cached). */
export function attachmentMismatch(ref: AttachmentRef, attachment: AttachmentBytes, checkBytes: boolean): string | null {
  if (checkBytes && attachment.byteSize !== attachment.data.byteLength) return `Attachment size mismatch: ${ref.attachmentId}`;
  if (checkBytes && createHash("sha256").update(attachment.data).digest("hex") !== attachment.sha256) return `Attachment checksum mismatch: ${ref.attachmentId}`;
  if ((typeof ref.sha256 === "string" && ref.sha256 !== attachment.sha256) || (typeof ref.mimeType === "string" && ref.mimeType !== attachment.mimeType)
    || (typeof ref.byteSize === "number" && ref.byteSize !== attachment.byteSize)) return `Attachment metadata mismatch: ${ref.attachmentId}`;
  return null;
}

function rejectMismatch(ref: AttachmentRef, attachment: AttachmentBytes, checkBytes: boolean): void {
  const mismatch = attachmentMismatch(ref, attachment, checkBytes);
  if (mismatch) throw new NodeRejection("invalid_request", mismatch);
}

/** Make server-owned bytes available in the disposable node cache before Pi admission. A reference the
 * server does not hold or whose bytes do not match rejects the command (`invalid_request`); `fetch`
 * rejects with its own `NodeRejection` when the server cannot be reached. */
export async function materializePromptAttachments(db: Database, sessionId: string, content: ClientPromptContent, fetch: FetchAttachment): Promise<void> {
  const unique = new Map<string, ImageRef>();
  for (const block of content) {
    if (block.type !== "image") continue;
    const prior = unique.get(block.attachmentId);
    if (prior && (prior.mimeType !== block.mimeType || prior.byteSize !== block.byteSize
      || (prior.sha256 && block.sha256 && prior.sha256 !== block.sha256))) {
      throw new NodeRejection("invalid_request", `Attachment conflicting references: ${block.attachmentId}`);
    }
    unique.set(block.attachmentId, prior?.sha256 ? prior : block);
  }
  for (const ref of unique.values()) {
    const cached = readCachedAttachment(db, sessionId, ref.attachmentId);
    if (cached) { rejectMismatch(ref, cached, false); continue; }
    const attachment = await fetch(sessionId, ref.attachmentId);
    if (!attachment) throw new NodeRejection("invalid_request", `Attachment unavailable: ${ref.attachmentId}`);
    rejectMismatch(ref, attachment, true);
    // Another prompt may have filled the cache while the fetch was in flight.
    if (!cacheAttachment(db, sessionId, ref.attachmentId, attachment)) {
      const existing = readCachedAttachment(db, sessionId, ref.attachmentId);
      if (!existing) throw new Error(`Attachment cache write failed: ${ref.attachmentId}`);
      rejectMismatch(ref, existing, false);
    }
  }
}

/** Convert cached references to provider image blocks without fetching or hashing again. */
export function hydrateCachedPrompt(db: Database, sessionId: string, content: ClientPromptContent) {
  return content.map(block => {
    if (block.type === "text") return block;
    const cached = readCachedAttachment(db, sessionId, block.attachmentId);
    if (!cached) return { type: "text" as const, text: "[Image attachment missing]" };
    const mismatch = attachmentMismatch(block, cached, false);
    if (mismatch) throw new Error(mismatch);
    return { type: "image" as const, data: Buffer.from(cached.data).toString("base64"), mimeType: cached.mimeType,
      ...(cached.filename ? { filename: cached.filename } : {}),
      ...(cached.width && cached.height ? { width: cached.width, height: cached.height } : {}) };
  });
}
