/** The methods the node serves (server→node): their schemas and the `nodeMethods` table. */
import { z } from "zod";
import {
  base64Chunk, id, MAX_FILE_ERROR_CHARS, MAX_PATH_CHARS, MAX_EXEC_COMMAND_CHARS, MAX_EXEC_VIEW_BYTES,
  cwd, streamId,
} from "./fields.js";
import { nodeError } from "./errors.js";
import type { MethodInput, MethodTable } from "./method-table.js";

/** `process.run`: runs `argv` (no shell) in a source's checkout and opens a stream of its stdout
 * (`binary`: raw bytes, else text). The node answers once it accepted the request; the stream's end frame
 * carries how the process ended (`exit`: code or signal, and the tail of its stderr), and cancelling the
 * stream kills the process. `env` is merged over the node's own environment. The server runs git this
 * way: the git logic stays on the server and the node only executes. */
export const MAX_PROCESS_ARGS = 1024;
export const processRunParams = z.strictObject({
  cwd, streamId,
  argv: z.array(z.string().max(65_536)).min(1).max(MAX_PROCESS_ARGS).refine(([program]) => !!program, "Missing program"),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(65_536)).optional(),
  binary: z.boolean().optional(),
});
export const processRunResult = z.strictObject({});

/** The node's files (`fs.*`, ADR-029): the file operations of Pi's `FileSystem` on the node's filesystem,
 * as Pi's local environment does them there, for the agent's tools, the server's discovery of a
 * checkout's context files and skills, and the file browser. `path` resolves against `cwd` (a source's
 * checkout; `~` is the node's home); nothing is confined to the checkout, as in Pi's local environment:
 * the server confines what a browser may name. Each answers a `Result`: a value, or a file error with
 * Pi's code, message and path. */
const filePath = z.string().max(MAX_PATH_CHARS);
const fileCall = { cwd, path: filePath };
export const fileErrorCode = z.enum(["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"]);
export const fileError = z.strictObject({ code: fileErrorCode, message: z.string().max(MAX_FILE_ERROR_CHARS), path: z.string().max(MAX_FILE_ERROR_CHARS).optional() });
const fileResult = <Value extends z.ZodType>(value: Value) => z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value }),
  z.strictObject({ ok: z.literal(false), error: fileError }),
]);
const fileKind = z.enum(["file", "directory", "symlink"]);
const fileMetadata = { name: z.string().max(MAX_FILE_ERROR_CHARS), kind: fileKind, size: z.number().nonnegative(), mtimeMs: z.number() };
/** Pi's `FileInfo`: what `lstat` says of a path (a symlink is not followed). */
export const fileInfo = z.strictObject({ ...fileMetadata, path: z.string().max(MAX_FILE_ERROR_CHARS) });
/** `fs.info`: the path's `fileInfo`, not following a symlink. A missing path is `not_found` (Pi's `exists`
 * is this). */
export const fsInfoParams = z.strictObject(fileCall);
export const fsInfoResult = fileResult(fileInfo);
/** `fs.list`: a directory's children, as `fileInfo` without their paths (each is the directory's `path`
 * joined with its `name`), in the order the filesystem lists them; other kinds of entries (sockets,
 * FIFOs) are left out. Bounded: at most `MAX_DIRECTORY_ENTRIES`, the rest cut off. */
export const MAX_DIRECTORY_ENTRIES = 100_000;
export const fsListParams = z.strictObject(fileCall);
export const fsListResult = fileResult(z.strictObject({ path: z.string().max(MAX_FILE_ERROR_CHARS), entries: z.array(z.strictObject(fileMetadata)).max(MAX_DIRECTORY_ENTRIES) }));
/** `fs.read`: a file's bytes, the first `maxBytes` of them if given, following a symlink. The value is
 * the file's size and the bytes follow as a binary stream, which ends at once, empty, on a failure. */
export const fsReadParams = z.strictObject({ ...fileCall, streamId, maxBytes: z.number().int().positive().optional() });
export const fsReadResult = fileResult(z.strictObject({ size: z.number().int().nonnegative() }));
/** `fs.write`: one chunk of a file written as Pi's `writeFile` writes it (creating its directories,
 * replacing a file there). `data` is base64 of at most `WRITE_CHUNK_BYTES` from `offset`: a write in one
 * chunk (offset 0 and `last`) is written at once; a longer one is kept under `writeId` in the node's data
 * directory until its `last` chunk writes the whole file, so a partly sent file is never seen at its
 * path. Every chunk may be sent again: it replaces what was kept from its offset, and the last, sent
 * again after it was written, is answered as written. A chunk past what was kept is `invalid_request`. */
export const fsWriteParams = z.strictObject({ ...fileCall, writeId: id, offset: z.number().int().nonnegative(), data: base64Chunk, last: z.boolean() });
export const fsWriteResult = fileResult(z.null());
/** `fs.absolutePath`: `path` resolved against `cwd` (and `~`), without requiring it to exist.
 * `fs.canonicalPath`: an existing path with its symlinks resolved. */
export const fsPathParams = z.strictObject(fileCall);
export const fsPathResult = fileResult(z.string().max(MAX_FILE_ERROR_CHARS));

/** Pi's bounded view of a shell command's output and the updates to it (`ShellOutputView`,
 * `ShellOutputUpdate`), as the node's shell capture produces them. */
const truncation = z.strictObject({
  truncated: z.boolean(), truncatedBy: z.enum(["lines", "bytes"]).nullable(),
  totalLines: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(),
  outputLines: z.number().int().nonnegative(), outputBytes: z.number().int().nonnegative(),
  lastLinePartial: z.boolean(), firstLineExceedsLimit: z.boolean(),
  maxLines: z.number().int().positive(), maxBytes: z.number().int().positive(),
});
const outputMetadata = { truncation, spillPath: z.string().max(4096).optional(), lastLineBytes: z.number().int().nonnegative().optional() };
export const shellOutputView = z.strictObject({ text: z.string(), ...outputMetadata });
const metadata = z.strictObject(outputMetadata);
export const shellOutputUpdate = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("replace"), output: shellOutputView }),
  z.strictObject({ kind: z.literal("append"), text: z.string(), metadata }),
  z.strictObject({ kind: z.literal("slide"), drop: z.number().int().nonnegative(), text: z.string(), metadata }),
  z.strictObject({ kind: z.literal("metadata"), metadata }),
]);
/** How a command ended, as Pi's `exec` returns it: its exit code and output metadata, or an execution
 * error with Pi's code. */
export const execExit = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.strictObject({ exitCode: z.number().int(), ...outputMetadata }) }),
  z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.enum(["aborted", "timeout", "shell_unavailable", "spawn_error", "callback_error", "unknown"]), message: z.string() }) }),
]);
/** One line of an exec's output stream (NDJSON, UTF-8): an update to the output's view, in order, then
 * its exit, the last line. Offsets into an exec's output count these lines' bytes. */
export const execRecord = z.union([z.strictObject({ update: shellOutputUpdate }), z.strictObject({ exit: execExit })]);
/** The agent's shell commands (`pi.*`, ADR-029): Pi's `exec` as its local environment runs it on the
 * node. `pi.exec`: runs `command` in the environment's shell (its shell, its environment merged with
 * `options.env`, `options.cwd` resolved against `cwd`, the timeout, the bounded capture and spill file of
 * `options.capture`), and opens a text stream of its output records (`execRecord`) from offset 0.
 * `execId` is the server's: the node keeps the command under it (see `pi.execAttach`); one already known
 * is refused `invalid_request`. */
export const piExecParams = z.strictObject({
  cwd, streamId, execId: id, command: z.string().max(MAX_EXEC_COMMAND_CHARS),
  options: z.strictObject({
    cwd: filePath.optional(),
    env: z.record(z.string().max(4096), z.string().max(65_536)).optional(),
    inheritEnv: z.boolean().optional(),
    timeout: z.number().positive().optional(),
    capture: z.strictObject({
      limits: z.strictObject({ maxBytes: z.number().int().positive().max(MAX_EXEC_VIEW_BYTES), maxLines: z.number().int().positive(), retain: z.enum(["head", "tail"]).optional() }),
      spill: z.boolean().optional(),
    }).optional(),
  }),
});
export const piExecResult = z.strictObject({});
/** `pi.execAttach`: reopens an exec's output stream from `offset` (the end of the last record the
 * server took), e.g. on a new connection after the old one dropped, while the command runs and for the
 * grace period after it exited or lost its stream. The node keeps only the tail of the records: from an
 * offset older than that it answers the current view instead (`view`, to replace the server's) and the
 * stream starts where its records end (`offset`). An unknown `execId` (the node restarted, or forgot it
 * after the grace period) is `not_found`: the command's outcome is unknown. */
export const piExecAttachParams = z.strictObject({ streamId, execId: id, offset: z.number().int().nonnegative() });
export const piExecAttachResult = z.strictObject({ offset: z.number().int().nonnegative(), view: shellOutputView.optional() });
/** `pi.execKill`: kills the exec's process (as aborting Pi's `exec` does); its stream still ends with
 * its exit. `killed`: whether it was running. Unknown: `not_found`. */
export const piExecKillParams = z.strictObject({ execId: id });
export const piExecKillResult = z.strictObject({ killed: z.boolean() });

/** `stream.cancel`: the server no longer wants a stream it opened on this connection (its consumer
 * cancelled, or it failed on the server). The node stops the stream's source and sends nothing more for
 * it; an unknown stream is ignored. */
export const streamCancelParams = z.strictObject({ streamId });

/** `node.reload`: restart the node on its current code at a clean point (ADR-021). The node refuses when
 * nothing would restart it or its new code does not build; otherwise it answers at once, before the
 * reload, refuses new shell commands and exits once none is in flight. `force`: cut off what is
 * still in flight at the drain bound instead of cancelling the reload. */
export const nodeReloadParams = z.strictObject({ force: z.boolean().optional() });
export const nodeReloadResult = z.strictObject({ scheduled: z.literal(true) });

/** Server→node methods: a node of this protocol version serves every one. A node rejection carries a
 * `NodeError` as `data`. The server bounds each call itself (its caller's timeout). */
export const nodeMethods = {
  "process.run": { params: processRunParams, result: processRunResult, errorData: nodeError },
  "fs.info": { params: fsInfoParams, result: fsInfoResult, errorData: nodeError },
  "fs.list": { params: fsListParams, result: fsListResult, errorData: nodeError },
  "fs.read": { params: fsReadParams, result: fsReadResult, errorData: nodeError },
  "fs.write": { params: fsWriteParams, result: fsWriteResult, errorData: nodeError },
  "fs.absolutePath": { params: fsPathParams, result: fsPathResult, errorData: nodeError },
  "fs.canonicalPath": { params: fsPathParams, result: fsPathResult, errorData: nodeError },
  "stream.cancel": { params: streamCancelParams },
  "node.reload": { params: nodeReloadParams, result: nodeReloadResult, errorData: nodeError },
  "pi.exec": { params: piExecParams, result: piExecResult, errorData: nodeError },
  "pi.execAttach": { params: piExecAttachParams, result: piExecAttachResult, errorData: nodeError },
  "pi.execKill": { params: piExecKillParams, result: piExecKillResult, errorData: nodeError },
} satisfies MethodTable;

type NodeInput<M extends keyof typeof nodeMethods> = MethodInput<(typeof nodeMethods)[M]>;
export type ProcessRun = NodeInput<"process.run">;
export type FsInfo = NodeInput<"fs.info">;
export type FsInfoResult = z.infer<typeof fsInfoResult>;
export type FsList = NodeInput<"fs.list">;
export type FsListResult = z.infer<typeof fsListResult>;
export type FsRead = NodeInput<"fs.read">;
export type FsReadResult = z.infer<typeof fsReadResult>;
export type FsWrite = NodeInput<"fs.write">;
export type FsWriteResult = z.infer<typeof fsWriteResult>;
export type FsPath = NodeInput<"fs.absolutePath">;
export type FsPathResult = z.infer<typeof fsPathResult>;
export type FileErrorData = z.infer<typeof fileError>;
export type NodeReload = NodeInput<"node.reload">;
export type PiExec = NodeInput<"pi.exec">;
export type PiExecAttach = NodeInput<"pi.execAttach">;
export type PiExecAttachResult = z.infer<typeof piExecAttachResult>;
export type PiExecKill = NodeInput<"pi.execKill">;
export type PiExecKillResult = z.infer<typeof piExecKillResult>;
export type ExecRecord = z.infer<typeof execRecord>;
