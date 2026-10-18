/** Field schemas and limits shared by the method schemas of both directions (`node-methods.ts`,
 * `server-methods.ts`). */
import { z } from "zod";

/** A bounded identifier: a node, a stream, a command, a write. */
export const id = z.string().min(1).max(128);

/** Streams (`stream.data`, `stream.end`, `stream.cancel`; node-transport.md *Streams*): the node splits its source
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
/** The node's files and commands (`fs.*`, `pi.*`): the longest path a file operation names (longer than
 * any path a filesystem accepts, so the node's own error answers it); the longest error message, name or
 * path an answer carries (the node cuts longer ones); the longest command; the most bytes a command's
 * output view may keep (its view then fits a frame). */
export const MAX_PATH_CHARS = 65_536;
export const MAX_FILE_ERROR_CHARS = 2 * MAX_PATH_CHARS;
export const MAX_EXEC_COMMAND_CHARS = 1024 * 1024;
export const MAX_EXEC_VIEW_BYTES = 1024 * 1024;
/** The directory a call works in: a source's checkout as the server resolves it. The node has no sources:
 * it works in the path it is sent. */
export const cwd = z.string().min(1).max(4096);

/** `fs.write` crosses in raw-byte chunks so each fits a 1 MiB frame after base64. */
export const WRITE_CHUNK_BYTES = 512 * 1024;
/** Base64 of at most one chunk's bytes. */
export const base64Chunk = z.string().max(Math.ceil(WRITE_CHUNK_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/);
/** A lowercase hex SHA-256 digest. */
export const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
