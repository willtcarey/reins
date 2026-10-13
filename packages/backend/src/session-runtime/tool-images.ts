import { createHash, randomUUID } from "node:crypto";
import { ALLOWED_IMAGE_MIME_TYPES, MAX_ATTACHMENT_BYTES, storeSessionAttachment } from "../session-attachments-store.js";
import { contentImages, mapContentImages, type ImageReferenceBlock, type InlineImageBlock } from "./events.js";
import type { AttachmentBytes, AttachmentCache } from "./attachments.js";

/** Replaces tool-result image content blocks before Pi commits them (Pi's `after_tool` hook); undefined keeps the content. */
export type ReferenceToolImages = (content: readonly unknown[]) => Promise<unknown[] | undefined>;
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
 * One inline image becomes an attachment reference the store already holds. If the runtime's cache holds
 * the same bytes (sha256) and MIME type (an image it stored, or a prompt attachment it read), the reference
 * reuses that ID and metadata. Otherwise the bytes are stored now under a new `att_<uuid>` ID, before the
 * commit that will reference them, and cached. An image the store would reject (MIME type outside the
 * upload allowlist, empty, or over the 10 MiB limit), or whose storing fails, is replaced by a text note
 * instead: a committed reference always names bytes the store holds.
 */
function referenceInlineImage(cache: AttachmentCache, sessionId: string, block: InlineImageBlock): ImageReferenceBlock | TextBlock {
  if (!ALLOWED_IMAGE_MIME_TYPES.has(block.mimeType)) return { type: "text", text: `[Image omitted: unsupported type ${block.mimeType || "unknown"}]` };
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
  try { storeSessionAttachment(sessionId, { id: attachmentId, data, mimeType: block.mimeType, filename: attachment.filename, width, height }); }
  catch (error) { return { type: "text", text: `[Image omitted: storing it failed: ${error instanceof Error ? error.message : String(error)}]` }; }
  cache.put(sessionId, attachmentId, attachment);
  return reference(attachmentId, attachment);
}

/** Copy of `value` with every inline image in a `content` array converted (see `referenceInlineImage`);
 * `value` itself when it has none. Images are converted one at a time, so repeats reuse one stored copy. */
export function referenceInlineImages<T>(cache: AttachmentCache, sessionId: string, value: T): T {
  const inline = contentImages(value).filter(isInlineImage);
  if (inline.length === 0) return value;
  const replaced = new Map<object, ImageReferenceBlock | TextBlock>();
  for (const block of inline) replaced.set(block, referenceInlineImage(cache, sessionId, block));
  return mapContentImages(value, block => replaced.get(block) ?? block) as T; // eslint-disable-line typescript-eslint/consistent-type-assertions -- only content image blocks are replaced
}

/**
 * Tool-created images (e.g. `read` on a PNG) become attachment references where Pi produces them, in
 * Pi's `after_tool` hook: Pi then commits (and stages) the reference, so neither a commit nor any live
 * event carries the bytes, and provider hydration reads them from the store. The runtime's storage
 * applies the same conversion to anything Pi commits without this hook (see `build.ts`).
 */
export function toolImageReferences(cache: AttachmentCache, sessionId: string): ReferenceToolImages {
  return async content => content.some(isInlineImage) ? referenceInlineImages(cache, sessionId, { content: [...content] }).content : undefined;
}
