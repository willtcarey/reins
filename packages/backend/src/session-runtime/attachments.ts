/**
 * A runtime's attachments: the bytes of the session's attachments it has used, cached in memory in front
 * of the attachment store on the process's database (`session-attachments-store.ts`, the only copy), so
 * provider hydration does not read every image from the database on every request. A miss is read from
 * the store; a runtime's cache goes with it.
 */
import { getSessionAttachment } from "../session-attachments-store.js";
import type { PromptBlock } from "./events.js";

/** Bytes of a session attachment with their metadata. */
export interface AttachmentBytes {
  data: Uint8Array;
  mimeType: string;
  byteSize: number;
  sha256: string;
  filename?: string;
  width?: number;
  height?: number;
}

/** What a stored reference declares about its attachment; undeclared fields are not checked. */
type AttachmentRef = { attachmentId: string; mimeType?: unknown; byteSize?: unknown; sha256?: unknown };
type ImageRef = Extract<PromptBlock, { type: "image" }>;
export type ProviderBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string; filename?: string; width?: number; height?: number };

/** A prompt names an attachment the session does not hold, or whose stored metadata does not match the reference. */
export class InvalidAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAttachmentError";
  }
}

export class AttachmentCache {
  private readonly sessions = new Map<string, Map<string, AttachmentBytes>>();

  /** The session's attachment, from the cache or else read from the store (and cached); null when the
   * store does not hold its bytes (it has none by that ID, or they were pruned). */
  get(sessionId: string, attachmentId: string): AttachmentBytes | null {
    const cached = this.sessions.get(sessionId)?.get(attachmentId);
    if (cached) return cached;
    const row = getSessionAttachment(sessionId, attachmentId);
    if (!row?.data) return null;
    const attachment: AttachmentBytes = {
      data: row.data, mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256,
      ...(row.filename ? { filename: row.filename } : {}),
      ...(row.width && row.height ? { width: row.width, height: row.height } : {}),
    };
    this.put(sessionId, attachmentId, attachment);
    return attachment;
  }

  /** The session's cached attachment with these bytes (sha256) and MIME type, with its ID, or null. */
  findByContent(sessionId: string, sha256: string, mimeType: string): { attachmentId: string; attachment: AttachmentBytes } | null {
    for (const [attachmentId, attachment] of this.sessions.get(sessionId) ?? []) {
      if (attachment.sha256 === sha256 && attachment.mimeType === mimeType) return { attachmentId, attachment };
    }
    return null;
  }

  /** Caches `attachment`, which the store holds under `attachmentId`. */
  put(sessionId: string, attachmentId: string, attachment: AttachmentBytes): void {
    const session = this.sessions.get(sessionId) ?? new Map<string, AttachmentBytes>();
    this.sessions.set(sessionId, session);
    session.set(attachmentId, attachment);
  }
}

/** The attachment `ref` names, from the cache or the store; null when the store does not hold it. One
 * whose stored metadata does not match what `ref` declares throws `InvalidAttachmentError`. */
function referenced(cache: AttachmentCache, sessionId: string, ref: AttachmentRef): AttachmentBytes | null {
  const attachment = cache.get(sessionId, ref.attachmentId);
  if (attachment && ((typeof ref.sha256 === "string" && ref.sha256 !== attachment.sha256)
    || (typeof ref.mimeType === "string" && ref.mimeType !== attachment.mimeType)
    || (typeof ref.byteSize === "number" && ref.byteSize !== attachment.byteSize))) {
    throw new InvalidAttachmentError(`Attachment metadata mismatch: ${ref.attachmentId}`);
  }
  return attachment;
}

/** Checks a prompt's attachment references against the store before admission (and caches their
 * bytes): one the session does not hold, or whose metadata does not match, throws `InvalidAttachmentError`. */
export function materializePromptAttachments(cache: AttachmentCache, sessionId: string, content: PromptBlock[]): void {
  const unique = new Map<string, ImageRef>();
  for (const block of content) {
    if (block.type !== "image") continue;
    const prior = unique.get(block.attachmentId);
    if (prior && (prior.mimeType !== block.mimeType || prior.byteSize !== block.byteSize
      || (prior.sha256 && block.sha256 && prior.sha256 !== block.sha256))) {
      throw new InvalidAttachmentError(`Attachment conflicting references: ${block.attachmentId}`);
    }
    unique.set(block.attachmentId, prior?.sha256 ? prior : block);
  }
  for (const ref of unique.values()) {
    if (!referenced(cache, sessionId, ref)) throw new InvalidAttachmentError(`Attachment unavailable: ${ref.attachmentId}`);
  }
}

/** Converts attachment references to provider image blocks, from the cache or the store. One the store
 * no longer holds becomes a placeholder. */
export function hydratePrompt(cache: AttachmentCache, sessionId: string, content: PromptBlock[]): ProviderBlock[] {
  return content.map((block): ProviderBlock => {
    if (block.type === "text") return block;
    const attachment = referenced(cache, sessionId, block);
    if (!attachment) return { type: "text", text: "[Image attachment missing]" };
    return { type: "image", data: Buffer.from(attachment.data).toString("base64"), mimeType: attachment.mimeType,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      ...(attachment.width && attachment.height ? { width: attachment.width, height: attachment.height } : {}) };
  });
}
