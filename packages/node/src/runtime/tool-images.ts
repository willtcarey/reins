import { createHash, randomUUID } from "node:crypto";
import { ATTACHMENT_IMAGE_MIME_TYPES, MAX_ATTACHMENT_BYTES, contentImages, mapContentImages, type ImageReferenceBlock, type InlineImageBlock } from "@reins/node-protocol";
import type { AttachmentBytes, AttachmentCache } from "../node-attachments.js";

/** Replaces tool-result image content blocks before Pi commits them (Pi's `after_tool` hook); undefined keeps the content. */
export type ReferenceToolImages = (content: readonly unknown[]) => Promise<unknown[] | undefined>;
/** Stores node-created bytes on the server under their node-assigned ID (`attachment.store`). */
export type UploadAttachment = (sessionId: string, attachmentId: string, attachment: AttachmentBytes) => Promise<void>;
type TextBlock = { type: "text"; text: string };

const isInlineImage = (block: unknown): block is InlineImageBlock => typeof block === "object" && block !== null
  && "type" in block && block.type === "image" && "data" in block && typeof block.data === "string"
  && "mimeType" in block && typeof block.mimeType === "string";
const sizeHint = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
const MIB = 1024 * 1024;

const reference = (attachmentId: string, attachment: AttachmentBytes): ImageReferenceBlock => ({
  type: "image", attachmentId, mimeType: attachment.mimeType, byteSize: attachment.byteSize, sha256: attachment.sha256,
  ...(attachment.filename !== undefined ? { filename: attachment.filename } : {}),
  ...(attachment.width !== undefined && attachment.height !== undefined ? { width: attachment.width, height: attachment.height } : {}),
});

/**
 * One inline image becomes an attachment reference the server already holds. If the session's cache
 * holds the same bytes (sha256) and MIME type (an image this node uploaded, or a prompt attachment the
 * server served), the reference reuses that ID and metadata. Otherwise the bytes are uploaded now under a
 * new `att_<uuid>` ID, before the commit that will reference them, and cached. An image the server would
 * reject (MIME type outside the upload allowlist, empty, or over the 10 MiB limit), or whose upload
 * fails, is replaced by a text note instead: a committed reference always names bytes the server holds.
 */
async function referenceInlineImage(cache: AttachmentCache, upload: UploadAttachment, sessionId: string, block: InlineImageBlock): Promise<ImageReferenceBlock | TextBlock> {
  if (!ATTACHMENT_IMAGE_MIME_TYPES.includes(block.mimeType)) return { type: "text", text: `[Image omitted: unsupported type ${block.mimeType || "unknown"}]` };
  const data = Buffer.from(block.data, "base64");
  if (data.byteLength === 0) return { type: "text", text: "[Image omitted: empty]" };
  if (data.byteLength > MAX_ATTACHMENT_BYTES) return { type: "text", text: `[Image omitted: larger than ${MAX_ATTACHMENT_BYTES / MIB} MiB]` };
  const sha256 = createHash("sha256").update(data).digest("hex");
  const cached = cache.findByContent(sessionId, sha256, block.mimeType);
  if (cached) return reference(cached.attachmentId, cached.attachment);
  const attachmentId = `att_${randomUUID()}`;
  const width = sizeHint(block.width), height = sizeHint(block.height);
  const attachment: AttachmentBytes = { data: new Uint8Array(data), mimeType: block.mimeType, byteSize: data.byteLength, sha256,
    ...(typeof block.filename === "string" ? { filename: block.filename } : {}), ...(width && height ? { width, height } : {}) };
  try { await upload(sessionId, attachmentId, attachment); }
  catch (error) { return { type: "text", text: `[Image omitted: upload failed: ${error instanceof Error ? error.message : String(error)}]` }; }
  return reference(attachmentId, cache.put(sessionId, attachmentId, attachment));
}

/** Copy of `value` with every inline image in a `content` array converted (see `referenceInlineImage`);
 * `value` itself when it has none. Images are converted one at a time, so repeats reuse one upload. */
export async function referenceInlineImages<T>(cache: AttachmentCache, upload: UploadAttachment, sessionId: string, value: T): Promise<T> {
  const inline = contentImages(value).filter(isInlineImage);
  if (inline.length === 0) return value;
  const replaced = new Map<object, ImageReferenceBlock | TextBlock>();
  for (const block of inline) replaced.set(block, await referenceInlineImage(cache, upload, sessionId, block));
  return mapContentImages(value, block => replaced.get(block) ?? block) as T; // eslint-disable-line typescript-eslint/consistent-type-assertions -- only content image blocks are replaced
}

/**
 * Node-created images (e.g. `read` on a PNG) become attachment references where Pi produces them, in
 * Pi's `after_tool` hook: Pi then commits (and stages) the reference, so neither a storage commit nor
 * any live event carries the bytes, and provider hydration (`toProviderMessages`) reads them from the
 * node cache. The node's storage applies the same conversion to anything Pi commits without this hook
 * (see `node.ts`).
 */
export function toolImageReferences(cache: AttachmentCache, upload: UploadAttachment, sessionId: string): ReferenceToolImages {
  return async content => content.some(isInlineImage) ? (await referenceInlineImages(cache, upload, sessionId, { content: [...content] })).content : undefined;
}
