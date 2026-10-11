/** The methods the server serves (node→server, base protocol): the frames of the streams the server opened
 * on a connection; their schemas and the `serverMethods` table. Every `*Params` schema is a method's params
 * without the connection's `epoch` (see `method-table.ts`). */
import { z } from "zod";
import { MAX_STREAM_CHUNK_CHARS, processExit, streamId } from "./fields.js";
import { MAX_ERROR_MESSAGE } from "./rpc.js";
import type { MethodInput, MethodTable } from "./method-table.js";

/** Streams the server opened on this connection (node-transport.md *Streams*), as notifications in stream order:
 * `stream.data` carries the next chunk, `offset` being the absolute byte offset of its first byte in the
 * stream: text (its UTF-8 bytes), or base64 of raw bytes for a binary stream (`encoding`). `stream.end`
 * is the stream's last frame: `error` says the source failed; `exit` is how a process stream's process
 * ended (a non-zero exit is not a stream failure). */
export const streamDataParams = z.strictObject({
  streamId, offset: z.number().int().min(0), data: z.string().min(1).max(MAX_STREAM_CHUNK_CHARS), encoding: z.literal("base64").optional(),
}).refine(({ data, encoding }) => encoding === undefined || /^[A-Za-z0-9+/]*={0,2}$/.test(data), "Invalid base64");
export const streamEndParams = z.strictObject({ streamId, error: z.string().max(MAX_ERROR_MESSAGE).optional(), exit: processExit.optional() });

/** Node→server methods are base protocol, not capability-gated: the server serves them only on a
 * negotiated connection for the epoch it issued. */
export const serverMethods = {
  "stream.data": { params: streamDataParams },
  "stream.end": { params: streamEndParams },
} satisfies MethodTable;

type ServerInput<M extends keyof typeof serverMethods> = MethodInput<(typeof serverMethods)[M]>;
export type StreamData = ServerInput<"stream.data">;
export type StreamEnd = ServerInput<"stream.end">;
