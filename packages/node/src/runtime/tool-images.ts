import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ATTACHMENT_IMAGE_MIME_TYPES, MAX_ATTACHMENT_BYTES } from "../protocol/schema.js";
import { contentImages, mapContentImages } from "../protocol/event-images.js";
import type { ImageReferenceBlock, InlineImageBlock } from "./types.js";

/** Replaces tool-result image content blocks before Pi commits them (Pi's `after_tool` hook); undefined keeps the content. */
export type ReferenceToolImages = (content: readonly unknown[]) => unknown[] | undefined;
type TextBlock = { type: "text"; text: string };
type CachedReference = { attachment_id: string; byte_size: number; filename: string | null; width: number | null; height: number | null };

const isInlineImage = (block: unknown): block is InlineImageBlock => typeof block === "object" && block !== null
  && "type" in block && block.type === "image" && "data" in block && typeof block.data === "string"
  && "mimeType" in block && typeof block.mimeType === "string";
const sizeHint = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
const MIB = 1024 * 1024;

/** Whether `value` holds an inline (byte-carrying) image block in any `content` array. */
export const hasInlineImages = (value: unknown): boolean => contentImages(value).some(isInlineImage);

/**
 * One inline image becomes an attachment reference, with no network call. If the session's cache already
 * holds the same bytes (sha256) and MIME type, the reference reuses that row's ID and metadata and nothing
 * is written: the row is either a node-created image whose upload row was appended in an earlier (or
 * this) transaction, so it precedes any commit row that can contain this reference, or was already
 * acknowledged; or a prompt attachment materialized by `attachment.fetch`, which the server already holds
 * under that ID. Otherwise the bytes go into the node's `node_attachments` cache under a new `att_<uuid>`
 * ID and an `attachment` upload row is appended to the session outbox (it names the cached row; the
 * bytes are not copied). Both writes join the caller's transaction, so the upload row is always ordered
 * before any commit row that can contain the reference. The server stores the bytes under exactly this
 * ID when the outbox drains (`attachment.store`). The reference always carries the cached row's metadata
 * (filename and dimensions are hints; the first occurrence's hints win), matching what the server holds
 * for that ID. An image the server would reject (MIME type outside the upload allowlist,
 * empty, or over the 10 MiB limit) is replaced by a text note instead, so every queued upload is one
 * the server accepts and a rejection is a true divergence.
 */
function referenceInlineImage(db: Database, sessionId: string, block: InlineImageBlock): ImageReferenceBlock | TextBlock {
  if (!ATTACHMENT_IMAGE_MIME_TYPES.includes(block.mimeType)) return { type: "text", text: `[Image omitted: unsupported type ${block.mimeType || "unknown"}]` };
  const data = Buffer.from(block.data, "base64");
  if (data.byteLength === 0) return { type: "text", text: "[Image omitted: empty]" };
  if (data.byteLength > MAX_ATTACHMENT_BYTES) return { type: "text", text: `[Image omitted: larger than ${MAX_ATTACHMENT_BYTES / MIB} MiB]` };
  const sha256 = createHash("sha256").update(data).digest("hex");
  const cached = db.query<CachedReference, [string, string, string]>(`SELECT attachment_id,byte_size,filename,width,height
    FROM node_attachments WHERE session_id = ? AND sha256 = ? AND mime_type = ? ORDER BY rowid LIMIT 1`).get(sessionId, sha256, block.mimeType);
  if (cached) {
    return { type: "image", attachmentId: cached.attachment_id, mimeType: block.mimeType, byteSize: cached.byte_size, sha256,
      ...(cached.filename !== null ? { filename: cached.filename } : {}),
      ...(cached.width !== null && cached.height !== null ? { width: cached.width, height: cached.height } : {}) };
  }
  const attachmentId = `att_${randomUUID()}`;
  const width = sizeHint(block.width), height = sizeHint(block.height);
  const hint = width && height ? { width, height } : {};
  const filename = typeof block.filename === "string" ? { filename: block.filename } : {};
  db.query(`INSERT INTO node_attachments(session_id,attachment_id,mime_type,byte_size,sha256,filename,width,height,data)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(sessionId, attachmentId, block.mimeType, data.byteLength, sha256,
    filename.filename ?? null, hint.width ?? null, hint.height ?? null, data);
  db.query("INSERT INTO session_outbox(session_id,kind,payload) VALUES(?,'attachment',?)")
    .run(sessionId, JSON.stringify({ attachmentId }));
  return { type: "image", attachmentId, mimeType: block.mimeType, byteSize: data.byteLength, sha256, ...filename, ...hint };
}

/** Copy of `value` with every inline image in a `content` array converted (see `referenceInlineImage`);
 * `value` itself when it has none. Runs in one transaction (a savepoint inside the caller's). */
export function referenceInlineImages<T>(db: Database, sessionId: string, value: T): T {
  if (!hasInlineImages(value)) return value;
  return db.transaction(() => mapContentImages(value, block => isInlineImage(block) ? referenceInlineImage(db, sessionId, block) : block))() as T; // eslint-disable-line typescript-eslint/consistent-type-assertions -- only content image blocks are replaced
}

/**
 * Node-created images (e.g. `read` on a PNG) become attachment references where Pi produces them, in
 * Pi's `after_tool` hook, synchronously and offline: Pi then commits (and stages) the reference, so
 * neither `session.committed` nor any live event carries the bytes, and provider hydration
 * (`toProviderMessages`) reads them from the node cache. The node storage adapter applies the same
 * conversion to anything Pi commits without this hook (see `openNodeStorage`).
 */
export function toolImageReferences(db: Database, sessionId: string): ReferenceToolImages {
  return content => content.some(isInlineImage) ? referenceInlineImages(db, sessionId, { content: [...content] }).content : undefined;
}
