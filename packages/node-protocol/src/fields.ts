/** Field schemas and limits shared by the method schemas of both directions (`node-methods.ts`,
 * `server-methods.ts`) and by the server's stored commands. Where two methods accept different values for
 * the same field, each composes its variant from these pieces and says so. */
import { z } from "zod";

/** A bounded identifier: a session, run, client input, script call, attachment reference, provider or node. */
export const id = z.string().min(1).max(128);
/** A model selection as it crosses the wire. */
export const sessionModel = z.strictObject({ provider: id, modelId: z.string().min(1).max(256) });
export const thinkingLevel = z.string().min(1).max(32);
/** The task a session belongs to, as the system prompt and branch checkout use it. */
export const sessionTask = z.strictObject({ title: z.string(), description: z.string().nullable(), branchName: z.string().min(1).max(1024) });

/** Streams (`stream.data`, `stream.end`, `stream.cancel`; see `streams.ts`): the node splits its source
 * into pieces of at most `STREAM_CHUNK_BYTES` bytes, small enough that other frames interleave between
 * chunks. A chunk's `data` is the text of one piece (plus up to 3 bytes of a character the previous piece
 * split), so it never holds more UTF-16 units than `MAX_STREAM_CHUNK_CHARS`. */
export const STREAM_CHUNK_BYTES = 64 * 1024;
export const MAX_STREAM_CHUNK_CHARS = 2 * STREAM_CHUNK_BYTES;
/** A stream's ID, allocated by the server for one connection and sent in the request that opens it. */
export const streamId = id;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Attachments cross in raw-byte chunks so a 10 MiB upload fits 1 MiB frames after base64. */
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;
/** Base64 of at most one chunk's bytes. */
export const base64Chunk = z.string().max(Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/);
/** A lowercase hex SHA-256 digest. */
export const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** Image MIME types an attachment may have. */
export const imageMimeType = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** Image MIME types an attachment may have; the node checks these limits before it references an image. */
export const ATTACHMENT_IMAGE_MIME_TYPES: readonly string[] = imageMimeType.options;
const imageDimensions = { width: z.number().int().positive().optional(), height: z.number().int().positive().optional() };
/** A whole attachment as transfers describe it (`attachment.fetch`, `attachment.store`): exact size
 * (`attachment.store` requires at least one byte) and digest. */
export const attachmentFields = {
  mimeType: z.string().min(1).max(128), byteSize: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES), sha256,
  filename: z.string().max(4096).optional(), ...imageDimensions,
};
/** An image block referencing a stored attachment (the node fetches or uploaded the bytes). Its size and
 * digest describe the attachment without being checked against it: any non-negative integer size, any
 * digest string. */
const imageReferenceFields = {
  type: z.literal("image"), attachmentId: id, mimeType: attachmentFields.mimeType,
  byteSize: z.number().int().min(0), sha256: z.string().max(128).optional(), filename: attachmentFields.filename, ...imageDimensions,
};
/** The reference that replaces an inline image block in session events. */
export const imageReference = z.strictObject(imageReferenceFields);

export const MAX_PROMPT_BLOCKS = 64;
export const MAX_PROMPT_TEXT = 4 * 1024 * 1024;
export const textBlock = z.strictObject({ type: z.literal("text"), text: z.string().max(MAX_PROMPT_TEXT) });
/** Inputs carry server-scoped attachment references, never inline image bytes (strict: a block with
 * `data` or any other extra field is rejected). Narrower than an event's reference: an allowed image MIME
 * type, at most `MAX_ATTACHMENT_BYTES` (not required to be an integer), paired dimensions. */
const promptImage = z.strictObject({ ...imageReferenceFields, mimeType: imageMimeType, byteSize: z.number().min(0).max(MAX_ATTACHMENT_BYTES) })
  .refine(value => (value.width === undefined) === (value.height === undefined), "Image dimensions must be paired");
/** Prompt/steer content: text and attachment references only (the node fetches the bytes). */
export const promptContent = z.array(z.union([textBlock, promptImage])).max(MAX_PROMPT_BLOCKS);
