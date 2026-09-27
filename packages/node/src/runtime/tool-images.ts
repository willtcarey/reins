import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { MAX_ATTACHMENT_BYTES, type AttachmentStore, type StoredAttachment } from "../protocol/schema.js";
import type { ImageReferenceBlock, InlineImageBlock } from "./types.js";

export type StoreAttachment = (input: AttachmentStore & { data: Uint8Array }) => Promise<StoredAttachment>;
/** Replaces tool-result image content blocks before Pi commits them (Pi's `after_tool` hook); undefined keeps the content. */
export type ReferenceToolImages = (content: readonly unknown[]) => Promise<unknown[] | undefined>;

const isInlineImage = (block: unknown): block is InlineImageBlock => typeof block === "object" && block !== null
  && "type" in block && block.type === "image" && "data" in block && typeof block.data === "string"
  && "mimeType" in block && typeof block.mimeType === "string";
const sizeHint = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/**
 * Node-created images (e.g. `read` on a PNG) become server attachments where Pi produces them: each
 * inline image in a tool result is stored with `attachment.store` and replaced by the same reference
 * shape as a prompt image, so Pi commits references and neither `session.committed` nor any live event
 * carries the bytes. The bytes are also written to the node's attachment cache under the server ID, so
 * provider hydration (`toProviderMessages`) reads them synchronously. The store is idempotent by sha256
 * and MIME type; if it fails (no connection, timeout, rejection) the inline block is kept, so the model
 * still sees the image and the run is not blocked beyond the call's timeout; that transcript then keeps
 * the bytes inline and its live events show a placeholder instead.
 */
export function toolImageReferences(db: Database, sessionId: string, store: StoreAttachment): ReferenceToolImages {
  const reference = async (block: InlineImageBlock): Promise<ImageReferenceBlock | InlineImageBlock> => {
    const data = new Uint8Array(Buffer.from(block.data, "base64"));
    if (data.byteLength === 0 || data.byteLength > MAX_ATTACHMENT_BYTES) return block;
    const sha256 = createHash("sha256").update(data).digest("hex");
    const width = sizeHint(block.width), height = sizeHint(block.height);
    let stored: StoredAttachment;
    try {
      stored = await store({ sessionId, mimeType: block.mimeType, sha256, byteSize: data.byteLength, data,
        ...(block.filename !== undefined ? { filename: block.filename } : {}), ...(width && height ? { width, height } : {}) });
    } catch (error) {
      console.error(`Failed to store tool-result image for ${sessionId}; keeping it inline:`, error);
      return block;
    }
    const hint = stored.width && stored.height ? { width: stored.width, height: stored.height } : width && height ? { width, height } : {};
    db.query(`INSERT OR IGNORE INTO node_attachments(session_id,attachment_id,mime_type,byte_size,sha256,filename,width,height,data)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionId, stored.attachmentId, stored.mimeType, stored.byteSize, stored.sha256,
      stored.filename ?? null, hint.width ?? null, hint.height ?? null, Buffer.from(data));
    return { type: "image", attachmentId: stored.attachmentId, mimeType: stored.mimeType, byteSize: stored.byteSize, sha256: stored.sha256,
      ...(stored.filename !== undefined ? { filename: stored.filename } : {}), ...hint };
  };
  return async content => {
    if (!content.some(isInlineImage)) return undefined;
    const replaced: unknown[] = [];
    for (const block of content) replaced.push(isInlineImage(block) ? await reference(block) : block);
    return replaced;
  };
}
