/** Field schemas and limits shared by the method schemas of both directions (`node-methods.ts`,
 * `server-methods.ts`) and by the server's stored commands. Where two methods accept different values for
 * the same field, each composes its variant from these pieces and says so. */
import { z } from "zod";

/** A bounded identifier: a session, run, client input, script call, attachment reference, provider or node. */
export const id = z.string().min(1).max(128);
/** A model selection as it crosses the wire. */
export const sessionModel = z.strictObject({ provider: id, modelId: z.string().min(1).max(256) });
export const thinkingLevel = z.string().min(1).max(32);
/** A git branch name. */
export const branchName = z.string().min(1).max(1024);
/** The longest system prompt an opening command carries. */
export const MAX_SYSTEM_PROMPT_CHARS = 4 * 1024 * 1024;
/** How a session runs, as the server resolves it from the session's kind: the system prompt, the tools the
 * model is offered (absent: every tool the node registers; names the node does not have reject the
 * command) and whether the node appends its environment to the prompt (the active tools, the REINS docs,
 * context files and skills). */
export const sessionRuntime = z.strictObject({
  systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_CHARS),
  tools: z.array(id).max(256).optional(),
  environment: z.boolean(),
});
export type SessionRuntime = z.infer<typeof sessionRuntime>;

/** Streams (`stream.data`, `stream.end`, `stream.cancel`; see `streams.ts`): the node splits its source
 * into pieces of at most `STREAM_CHUNK_BYTES` bytes, small enough that other frames interleave between
 * chunks. A chunk's `data` is the text of one piece (plus up to 3 bytes of a character the previous piece
 * split), so it never holds more UTF-16 units than `MAX_STREAM_CHUNK_CHARS`. */
export const STREAM_CHUNK_BYTES = 64 * 1024;
export const MAX_STREAM_CHUNK_CHARS = 2 * STREAM_CHUNK_BYTES;
/** A stream's ID, allocated by the server for one connection and sent in the request that opens it. */
export const streamId = id;
/** The tail of a process's stderr that its stream's end frame carries. */
export const MAX_PROCESS_STDERR_CHARS = 64 * 1024;
/** How a process ended (`process.run`): its exit code, or the signal that killed it, and its stderr. */
export const processExit = z.strictObject({
  code: z.number().int().nullable(), signal: z.string().max(32).nullable(), stderr: z.string().max(MAX_PROCESS_STDERR_CHARS),
});
export type ProcessExit = z.infer<typeof processExit>;
/** A source's checkout on its node: the source and its path as the server resolves it (as in a session
 * binding: the node has no sources table yet). */
export const sourceCheckout = { sourceId: z.number().int().positive(), cwd: z.string().min(1).max(4096) };

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Attachments and `fs.write` cross in raw-byte chunks so each fits a 1 MiB frame after base64. */
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
