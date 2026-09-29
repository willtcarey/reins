import { createHash } from "node:crypto";
import type { ClientPromptContent } from "./runtime/types.js";
import { NodeRejection } from "@reins/node-protocol";

/** Attachment bytes with their metadata, as the server serves them and the node caches them. */
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
type ProviderBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string; filename?: string; width?: number; height?: number };

/**
 * The node's attachment cache (ADR-015): in memory only, per session, holding bytes the server already
 * has (prompt attachments it served, tool-result images the node uploaded). Nothing in it is canonical:
 * a miss is fetched from the server again, and a session's entries go when its runtime closes (`drop`).
 */
export class AttachmentCache {
  private readonly sessions = new Map<string, Map<string, AttachmentBytes>>();

  get(sessionId: string, attachmentId: string): AttachmentBytes | null {
    return this.sessions.get(sessionId)?.get(attachmentId) ?? null;
  }

  /** The session's cached attachment with these bytes (sha256) and MIME type, with its ID, or null. */
  findByContent(sessionId: string, sha256: string, mimeType: string): { attachmentId: string; attachment: AttachmentBytes } | null {
    for (const [attachmentId, attachment] of this.sessions.get(sessionId) ?? []) {
      if (attachment.sha256 === sha256 && attachment.mimeType === mimeType) return { attachmentId, attachment };
    }
    return null;
  }

  /** Caches `attachment` under `attachmentId` unless the session already holds that ID; returns the cached entry. */
  put(sessionId: string, attachmentId: string, attachment: AttachmentBytes): AttachmentBytes {
    const session = this.sessions.get(sessionId) ?? new Map<string, AttachmentBytes>();
    this.sessions.set(sessionId, session);
    const existing = session.get(attachmentId);
    if (existing) return existing;
    session.set(attachmentId, attachment);
    return attachment;
  }

  drop(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
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

/** The cached attachment for `ref`, fetched from the server (and verified) on a miss; null when the
 * server does not hold it. A mismatch throws a `NodeRejection` (`invalid_request`). */
async function cachedOrFetched(cache: AttachmentCache, sessionId: string, ref: AttachmentRef, fetch: FetchAttachment): Promise<AttachmentBytes | null> {
  const cached = cache.get(sessionId, ref.attachmentId);
  if (cached) { rejectMismatch(ref, cached, false); return cached; }
  const attachment = await fetch(sessionId, ref.attachmentId);
  if (!attachment) return null;
  rejectMismatch(ref, attachment, true);
  // Another caller may have filled the cache while the fetch was in flight.
  const stored = cache.put(sessionId, ref.attachmentId, attachment);
  if (stored !== attachment) rejectMismatch(ref, stored, false);
  return stored;
}

/** Makes server-owned bytes available in the node cache before Pi admission. A reference the server
 * does not hold or whose bytes do not match rejects the command (`invalid_request`); `fetch` rejects with
 * its own `NodeRejection` when the server cannot be reached. */
export async function materializePromptAttachments(cache: AttachmentCache, sessionId: string, content: ClientPromptContent, fetch: FetchAttachment): Promise<void> {
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
    if (!await cachedOrFetched(cache, sessionId, ref, fetch)) throw new NodeRejection("invalid_request", `Attachment unavailable: ${ref.attachmentId}`);
  }
}

/** Converts attachment references to provider image blocks, from the cache or (on a miss, e.g. history
 * from before the runtime opened) the server. One the server no longer holds becomes a placeholder. */
export async function hydratePrompt(cache: AttachmentCache, sessionId: string, content: ClientPromptContent, fetch: FetchAttachment): Promise<ProviderBlock[]> {
  return Promise.all(content.map(async (block): Promise<ProviderBlock> => {
    if (block.type === "text") return block;
    const attachment = await cachedOrFetched(cache, sessionId, block, fetch);
    if (!attachment) return { type: "text", text: "[Image attachment missing]" };
    return { type: "image", data: Buffer.from(attachment.data).toString("base64"), mimeType: attachment.mimeType,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      ...(attachment.width && attachment.height ? { width: attachment.width, height: attachment.height } : {}) };
  }));
}
