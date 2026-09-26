import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { ClientPromptContent } from "./types.js";

type ImageRef = Extract<ClientPromptContent[number], { type: "image" }>;
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
export class AttachmentMaterializationError extends Error {}

type CachedMetadata = { mime_type: string; byte_size: number; sha256: string };
type CachedAttachment = CachedMetadata & {
  filename: string | null;
  width: number | null;
  height: number | null;
  data: Uint8Array;
};

function cachedMetadata(db: Database, sessionId: string, id: string): CachedMetadata | null {
  return db.query<CachedMetadata, [string, string]>(
    "SELECT mime_type,byte_size,sha256 FROM node_attachments WHERE session_id=? AND attachment_id=?",
  ).get(sessionId, id) ?? null;
}

function cachedAttachment(db: Database, sessionId: string, id: string): CachedAttachment | null {
  return db.query<CachedAttachment, [string, string]>(
    "SELECT mime_type,byte_size,sha256,filename,width,height,data FROM node_attachments WHERE session_id=? AND attachment_id=?",
  ).get(sessionId, id) ?? null;
}

function verifyMetadata(ref: ImageRef, attachment: CachedMetadata): void {
  if (attachment.mime_type !== ref.mimeType || attachment.byte_size !== ref.byteSize
    || (ref.sha256 && attachment.sha256 !== ref.sha256)) {
    throw new AttachmentMaterializationError(`Attachment metadata mismatch: ${ref.attachmentId}`);
  }
}

function verifyFetched(ref: ImageRef, attachment: AttachmentBytes): void {
  verifyMetadata(ref, { mime_type: attachment.mimeType, byte_size: attachment.byteSize, sha256: attachment.sha256 });
  if (attachment.byteSize !== attachment.data.byteLength) {
    throw new AttachmentMaterializationError(`Attachment size mismatch: ${ref.attachmentId}`);
  }
  if (createHash("sha256").update(attachment.data).digest("hex") !== attachment.sha256) {
    throw new AttachmentMaterializationError(`Attachment checksum mismatch: ${ref.attachmentId}`);
  }
}

/** Make server-owned bytes available in the disposable node cache before Pi admission. */
export async function materializePromptAttachments(db: Database, sessionId: string, content: ClientPromptContent, fetch: FetchAttachment): Promise<void> {
  const unique = new Map<string, ImageRef>();
  for (const block of content) {
    if (block.type !== "image") continue;
    const prior = unique.get(block.attachmentId);
    if (prior && (prior.mimeType !== block.mimeType || prior.byteSize !== block.byteSize
      || (prior.sha256 && block.sha256 && prior.sha256 !== block.sha256))) {
      throw new AttachmentMaterializationError(`Attachment conflicting references: ${block.attachmentId}`);
    }
    unique.set(block.attachmentId, prior?.sha256 ? prior : block);
  }
  for (const ref of unique.values()) {
    const cached = cachedMetadata(db, sessionId, ref.attachmentId);
    if (cached) { verifyMetadata(ref, cached); continue; }
    const attachment = await fetch(sessionId, ref.attachmentId);
    if (!attachment) throw new AttachmentMaterializationError(`Attachment unavailable: ${ref.attachmentId}`);
    verifyFetched(ref, attachment);
    const inserted = db.query(`INSERT OR IGNORE INTO node_attachments(session_id,attachment_id,mime_type,byte_size,sha256,filename,width,height,data)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionId, ref.attachmentId, attachment.mimeType, attachment.byteSize,
      attachment.sha256, attachment.filename ?? null, attachment.width ?? null, attachment.height ?? null, Buffer.from(attachment.data));
    // Another prompt may have filled the cache while the fetch was in flight.
    if (!inserted.changes) {
      const existing = cachedMetadata(db, sessionId, ref.attachmentId);
      if (!existing) throw new Error(`Attachment cache write failed: ${ref.attachmentId}`);
      verifyMetadata(ref, existing);
    }
  }
}

/** Convert cached references to provider image blocks without fetching or hashing again. */
export function hydrateCachedPrompt(db: Database, sessionId: string, content: ClientPromptContent) {
  return content.map(block => {
    if (block.type === "text") return block;
    const row = cachedAttachment(db, sessionId, block.attachmentId);
    if (!row) return { type: "text" as const, text: "[Image attachment missing]" };
    verifyMetadata(block, row);
    return { type: "image" as const, data: Buffer.from(row.data).toString("base64"), mimeType: row.mime_type,
      ...(row.filename ? { filename: row.filename } : {}),
      ...(row.width && row.height ? { width: row.width, height: row.height } : {}) };
  });
}
