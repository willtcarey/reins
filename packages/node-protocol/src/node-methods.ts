/** The methods the node serves (server→node, the negotiated capabilities): their schemas and the
 * `nodeMethods` table, plus the server's durable vocabulary for the session work among them (the
 * commands `node_command_outbox` stores and their results). Every `*Params` schema is a method's params
 * without the connection's `epoch` (see `method-table.ts`). */
import { z } from "zod";
import {
  base64Chunk, branchName, id, MAX_CHECKOUT_ENVIRONMENT_BYTES, MAX_ENV_ERROR_CHARS, MAX_ENV_PATH_CHARS, MAX_EXEC_COMMAND_CHARS, MAX_EXEC_VIEW_BYTES,
  promptContent, sessionModel, sessionRuntime, sourceCheckout, streamId, thinkingLevel,
} from "./fields.js";
import { nodeError } from "./errors.js";
import { methodNames, type MethodInput, type MethodTable } from "./method-table.js";

/** The node session binding the server resolves from its product rows on every session command: where
 * the session runs (its source and checkout) and the identity Pi's session is created with. The node
 * stores nothing: it opens the session's runtime from the binding the command carries. */
export const binding = z.strictObject({
  sourceId: z.number().int().positive(), cwd: z.string().min(1).max(4096),
  createdAt: z.string().min(1).max(128), parentSessionId: id.nullable(),
});
export type NodeSessionBinding = z.infer<typeof binding>;
/** Server→node session commands carry the session and its binding. The node keeps no per-command state:
 * a replay after an unknown outcome converges on the command's own state (see node-contract.md). */
const sessionCommand = { sessionId: id, binding };
/** The model and thinking level (null: off) Pi's main lane starts with when the session has none yet:
 * the node seeds the lane from it when it opens the runtime (null model: none resolved, so the session
 * cannot run until `session.setModel`). Once the lane exists, Pi's own lane state is the selection. */
const laneSeed = z.strictObject({ model: sessionModel.nullable(), thinkingLevel: thinkingLevel.nullable() });
/** Commands that may open the session's runtime also carry what the node opens it with: the branch it
 * checks out first (null: none, e.g. a scratch session or a utility kind), the lane seed and the runtime configuration (the system
 * prompt, active tools and whether the node appends its environment; see `sessionRuntime`). The server
 * resolves all three from its rows when it sends the command; a runtime already open keeps what it was
 * opened with. */
const openingCommand = { ...sessionCommand, branch: branchName.nullable(), lane: laneSeed, runtime: sessionRuntime };
/** What a prompt/steer and a model change say, as stored and as sent. */
const sessionInputFields = { sessionId: id, clientId: id, content: promptContent, sourceSessionId: id.nullable() };
const sessionModelFields = { ...sessionModel.shape, thinkingLevel: thinkingLevel.optional() };
/** Prompt/steer `content` (`promptContent`, shared with the stored command): text and server attachment
 * references only (the node fetches the bytes with `attachment.fetch`), never inline bytes. A replay is
 * recognized by Pi's durable input ID (`clientId`). */
export const sessionInputParams = z.strictObject({ ...openingCommand, ...sessionInputFields });
export const sessionSetModelParams = z.strictObject({ ...openingCommand, ...sessionModelFields });
/** `session.abort` and `session.resumePending`: called directly by the server (never queued or
 * replayed). Abort never opens a runtime, so it carries only the binding; resuming may. Resuming is
 * replay-safe: `started` is true while the session's pending operation is being driven (also when an
 * input joined it first) and false when there is nothing to resume. */
export const sessionAbortParams = z.strictObject(sessionCommand);
export const sessionResumeParams = z.strictObject(openingCommand);
/** `session.close`: a direct call telling the node the session no longer runs there (it was moved
 * to another node or deleted). The node aborts a run and closes the session's runtime if one is open;
 * `closed` says whether one was. No binding: the server has re-pointed or deleted the session already.
 * Best effort: a node that misses it keeps a runtime it is sent no more commands for, and the server
 * fences every call from it. */
export const sessionCloseParams = z.strictObject({ sessionId: id });
export const sessionInputResult = z.strictObject({ inputId: z.string().min(1) });
export const sessionSetModelResult = z.strictObject({ modelSet: z.literal(true) });
export const sessionAbortResult = z.strictObject({ aborted: z.boolean() });
export const sessionResumeResult = z.strictObject({ started: z.boolean() });
export const sessionCloseResult = z.strictObject({ closed: z.boolean() });
/** `skills.list`: the skills a source's checkout offers (for prompt suggestions), read by the node at
 * the source's `cwd` (the path the server resolves for the source, as in a session binding). Read-only
 * and never queued: a server with no connected node answers without it. Bounded: the node sends at most
 * `MAX_LISTED_SKILLS`. */
export const MAX_LISTED_SKILLS = 1024;
export const skillsListParams = z.strictObject({ sourceId: z.number().int().positive(), cwd: z.string().min(1).max(4096) });
export const skillInfo = z.strictObject({ name: id, description: z.string().max(4096) });
export const skillsListResult = z.strictObject({ skills: z.array(skillInfo).max(MAX_LISTED_SKILLS) });

/** `process.run`: runs `argv` (no shell) in a source's checkout and opens a stream of its stdout
 * (`binary`: raw bytes, else text). The node answers once it accepted the request; the stream's end frame
 * carries how the process ended (`exit`: code or signal, and the tail of its stderr), and cancelling the
 * stream kills the process. `env` is merged over the node's own environment. The server runs git this
 * way: the git logic stays on the server and the node only executes. */
export const MAX_PROCESS_ARGS = 1024;
export const processRunParams = z.strictObject({
  ...sourceCheckout, streamId,
  argv: z.array(z.string().max(65_536)).min(1).max(MAX_PROCESS_ARGS).refine(([program]) => !!program, "Missing program"),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(65_536)).optional(),
  binary: z.boolean().optional(),
});
export const processRunResult = z.strictObject({});
/** `fs.list`: one directory of a source's checkout (`path` relative to it; one escaping it is
 * `invalid_request`, a missing directory `not_found`), files and directories only (no symlinks or
 * other entries), directories first, then by name. Bounded: at most `MAX_DIRECTORY_ENTRIES`. */
export const MAX_DIRECTORY_ENTRIES = 100_000;
export const fsListParams = z.strictObject({ ...sourceCheckout, path: z.string().min(1).max(4096) });
export const directoryEntry = z.strictObject({ name: z.string().min(1).max(1024), type: z.enum(["file", "directory"]) });
export const fsListResult = z.strictObject({ entries: z.array(directoryEntry).max(MAX_DIRECTORY_ENTRIES) });
/** `fs.read`: one file of a source's checkout (`path` relative to it, as `fs.list`; one escaping it is
 * `invalid_request`, anything but a file `not_found`). The result is the file's size; its bytes, the
 * first `maxBytes` of them if given, follow as a binary stream. */
export const fsReadParams = z.strictObject({ ...sourceCheckout, streamId, path: z.string().min(1).max(4096), maxBytes: z.number().int().positive().optional() });
export const fsReadResult = z.strictObject({ size: z.number().int().nonnegative() });
/** `fs.write`: one chunk of a file written into a source's checkout (`path` relative to it, as
 * `fs.list`; one escaping it, or naming a directory, is `invalid_request`). Chunks are sent in order:
 * `offset` 0 starts the file (creating its directories), each later one must start where the written
 * bytes end (else `invalid_request`), and `last` puts the file in place (replacing one there): until
 * then the bytes are kept beside it, so a partly written file is never seen at its path. The result is
 * the bytes written so far. */
export const fsWriteParams = z.strictObject({
  ...sourceCheckout, path: z.string().min(1).max(4096),
  offset: z.number().int().nonnegative(), data: base64Chunk, last: z.boolean(),
});
export const fsWriteResult = z.strictObject({ size: z.number().int().nonnegative() });

/** The node as a tool host (ADR-029): the operations of Pi's tools (read, write, edit, bash) as a
 * remote `ExecutionEnv` on a source's checkout. `cwd` is the environment's working directory: it only
 * resolves relative paths, nothing is confined to it (as in Pi's local environment). Results are shaped
 * as Pi's: a value, or a file error with Pi's code, message and path. */
const envPath = z.string().max(MAX_ENV_PATH_CHARS);
const envCall = { ...sourceCheckout, streamId };
export const fileErrorCode = z.enum(["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"]);
export const fileError = z.strictObject({ code: fileErrorCode, message: z.string().max(MAX_ENV_ERROR_CHARS), path: z.string().max(MAX_ENV_ERROR_CHARS).optional() });
export const fileInfo = z.strictObject({
  name: z.string().max(MAX_ENV_ERROR_CHARS), path: z.string().max(MAX_ENV_ERROR_CHARS),
  kind: z.enum(["file", "directory", "symlink"]), size: z.number().nonnegative(), mtimeMs: z.number(),
});
/** `env.fs`: one file operation (`op`, with its `args`), answered with Pi's `Result`. It opens a binary
 * stream, which carries the file's bytes for `readTextFile` and `readBinaryFile` (the value is then
 * their count, `{size}`) and ends at once, empty, for every other operation and every failure.
 * `writeFile` crosses in chunks like `fs.write`'s: `data` is base64 of at most `ATTACHMENT_CHUNK_BYTES`
 * from `offset`; a write in one chunk (offset 0 and `last`) is written at once, a longer one is kept
 * under `writeId` in the node's data directory until its `last` chunk writes the whole file. A chunk may
 * be sent again (it replaces what was kept from its offset), and so may the last after it was written. */
const pathOp = <Op extends string>(op: Op) => z.strictObject({ ...envCall, op: z.literal(op), args: z.strictObject({ path: envPath }) });
export const envFsParams = z.discriminatedUnion("op", [
  pathOp("absolutePath"), pathOp("canonicalPath"), pathOp("exists"), pathOp("fileInfo"), pathOp("readTextFile"), pathOp("readBinaryFile"),
  z.strictObject({
    ...envCall, op: z.literal("writeFile"),
    args: z.strictObject({ path: envPath, writeId: id, offset: z.number().int().nonnegative(), data: base64Chunk, last: z.boolean() }),
  }),
]);
export const envFsResult = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.union([z.string().max(MAX_ENV_ERROR_CHARS), z.boolean(), fileInfo, z.strictObject({ size: z.number().int().nonnegative() }), z.null()]) }),
  z.strictObject({ ok: z.literal(false), error: fileError }),
]);

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
/** `env.exec`: runs `command` in the environment's shell as Pi's local environment does (its shell, its
 * environment merged with `options.env`, `options.cwd` resolved against `cwd`, the timeout, the bounded
 * capture and spill file of `options.capture`), and opens a text stream of its output records
 * (`execRecord`) from offset 0. `execId` is the server's: the node keeps the command under it (see
 * `env.execAttach`); one already known is refused `invalid_request`. */
export const envExecParams = z.strictObject({
  ...envCall, execId: id, command: z.string().max(MAX_EXEC_COMMAND_CHARS),
  options: z.strictObject({
    cwd: envPath.optional(),
    env: z.record(z.string().max(4096), z.string().max(65_536)).optional(),
    inheritEnv: z.boolean().optional(),
    timeout: z.number().positive().optional(),
    capture: z.strictObject({
      limits: z.strictObject({ maxBytes: z.number().int().positive().max(MAX_EXEC_VIEW_BYTES), maxLines: z.number().int().positive(), retain: z.enum(["head", "tail"]).optional() }),
      spill: z.boolean().optional(),
    }).optional(),
  }),
});
export const envExecResult = z.strictObject({});
/** `env.execAttach`: reopens an exec's output stream from `offset` (the end of the last record the
 * server took), e.g. on a new connection after the old one dropped, while the command runs and for the
 * grace period after it exited or lost its stream. The node keeps only the tail of the records: from an
 * offset older than that it answers the current view instead (`view`, to replace the server's) and the
 * stream starts where its records end (`offset`). An unknown `execId` (the node restarted, or forgot it
 * after the grace period) is `not_found`: the command's outcome is unknown. */
export const envExecAttachParams = z.strictObject({ streamId, execId: id, offset: z.number().int().nonnegative() });
export const envExecAttachResult = z.strictObject({ offset: z.number().int().nonnegative(), view: shellOutputView.optional() });
/** `env.execKill`: kills the exec's process (as aborting Pi's `exec` does); its stream still ends with
 * its exit. `killed`: whether it was running. Unknown: `not_found`. */
export const envExecKillParams = z.strictObject({ execId: id });
export const envExecKillResult = z.strictObject({ killed: z.boolean() });

/** `checkout.environment`: what of a session's environment comes from its checkout, with content: the
 * context files (AGENTS.md in the checkout and its ancestors, root first) and the checkout's skills
 * (`.agents/skills`), never the node's own `~/.agents` (the server supplies its own); and where this
 * node's REINS docs are (`docs.dir`; `devDocs`: whether it has the developer docs, `<dir>/dev`). A
 * missing checkout is `not_found`; one whose environment would not fit a frame (more than
 * `MAX_CHECKOUT_ENVIRONMENT_BYTES` as JSON) `invalid_request`. */
export const checkoutEnvironmentParams = z.strictObject(sourceCheckout);
export const checkoutEnvironmentResult = z.strictObject({
  contextFiles: z.array(z.strictObject({ path: z.string().max(4096), content: z.string().max(MAX_CHECKOUT_ENVIRONMENT_BYTES) })).max(1024),
  skills: z.array(z.strictObject({
    name: id, description: z.string().max(65_536), path: z.string().max(4096), content: z.string().max(MAX_CHECKOUT_ENVIRONMENT_BYTES),
    disableModelInvocation: z.boolean(),
  })).max(MAX_LISTED_SKILLS),
  docs: z.strictObject({ dir: z.string().max(4096), devDocs: z.boolean() }),
});

/** `stream.cancel`: the server no longer wants a stream it opened on this connection (its consumer
 * cancelled, or it failed on the server). The node stops the stream's source and sends nothing more for
 * it; an unknown stream is ignored. A node advertises this capability when it serves streams. */
export const streamCancelParams = z.strictObject({ streamId });

/** `credentials.changed`: a credential for the provider was set or deleted on the server (an API key, an
 * OAuth login or logout; not a routine token refresh). The node drops what it cached for the provider, and
 * a `credentials.*` call already in flight for it is not cached, so its next read asks the server again.
 * Best effort: a node that misses it re-reads every credential when it next attaches. */
export const credentialsChangedParams = z.strictObject({ providerId: id });

/** `node.reload`: restart the node on its current code at a clean point (ADR-021). The node refuses when
 * nothing would restart it or its new code does not build; otherwise it answers at once, before the
 * reload, holds every run at its next pause point and exits once nothing is in flight. `force`: cut off
 * what is still in flight at the drain bound instead of cancelling the reload. */
export const nodeReloadParams = z.strictObject({ force: z.boolean().optional() });
export const nodeReloadResult = z.strictObject({ scheduled: z.literal(true) });

/** Server→node methods: the negotiated capabilities (`capability`); the node advertises each one it
 * serves. A node rejection carries a `NodeError` as `data`. The server bounds each call itself (its
 * caller's timeout). */
export const nodeMethods = {
  "session.prompt": { params: sessionInputParams, result: sessionInputResult, errorData: nodeError },
  "session.steer": { params: sessionInputParams, result: sessionInputResult, errorData: nodeError },
  "session.setModel": { params: sessionSetModelParams, result: sessionSetModelResult, errorData: nodeError },
  "session.abort": { params: sessionAbortParams, result: sessionAbortResult, errorData: nodeError },
  "session.resumePending": { params: sessionResumeParams, result: sessionResumeResult, errorData: nodeError },
  "session.close": { params: sessionCloseParams, result: sessionCloseResult, errorData: nodeError },
  "skills.list": { params: skillsListParams, result: skillsListResult, errorData: nodeError },
  "process.run": { params: processRunParams, result: processRunResult, errorData: nodeError },
  "fs.list": { params: fsListParams, result: fsListResult, errorData: nodeError },
  "fs.read": { params: fsReadParams, result: fsReadResult, errorData: nodeError },
  "fs.write": { params: fsWriteParams, result: fsWriteResult, errorData: nodeError },
  "stream.cancel": { params: streamCancelParams },
  "credentials.changed": { params: credentialsChangedParams },
  "node.reload": { params: nodeReloadParams, result: nodeReloadResult, errorData: nodeError },
  "env.fs": { params: envFsParams, result: envFsResult, errorData: nodeError },
  "env.exec": { params: envExecParams, result: envExecResult, errorData: nodeError },
  "env.execAttach": { params: envExecAttachParams, result: envExecAttachResult, errorData: nodeError },
  "env.execKill": { params: envExecKillParams, result: envExecKillResult, errorData: nodeError },
  "checkout.environment": { params: checkoutEnvironmentParams, result: checkoutEnvironmentResult, errorData: nodeError },
} satisfies MethodTable;
/** Server→node methods are negotiated capabilities. */
export const capability = z.enum(methodNames(nodeMethods));
export type Capability = z.infer<typeof capability>;

type NodeInput<M extends keyof typeof nodeMethods> = MethodInput<(typeof nodeMethods)[M]>;
export type SessionInput = NodeInput<"session.prompt">;
export type SessionSetModel = NodeInput<"session.setModel">;
export type SessionAbort = NodeInput<"session.abort">;
export type SessionResume = NodeInput<"session.resumePending">;
export type SessionClose = NodeInput<"session.close">;
/** The main lane seed opening commands carry. */
export type LaneSeed = z.infer<typeof laneSeed>;
export type SkillsList = NodeInput<"skills.list">;
export type SkillInfo = z.infer<typeof skillInfo>;
export type SkillsListResult = z.infer<typeof skillsListResult>;
export type ProcessRun = NodeInput<"process.run">;
export type FsList = NodeInput<"fs.list">;
export type FsListResult = z.infer<typeof fsListResult>;
export type FsRead = NodeInput<"fs.read">;
export type FsReadResult = z.infer<typeof fsReadResult>;
export type FsWrite = NodeInput<"fs.write">;
export type FsWriteResult = z.infer<typeof fsWriteResult>;
export type CredentialsChanged = NodeInput<"credentials.changed">;
export type NodeReload = NodeInput<"node.reload">;
export type DirectoryEntry = z.infer<typeof directoryEntry>;
export type EnvFs = NodeInput<"env.fs">;
export type EnvFsResult = z.infer<typeof envFsResult>;
export type EnvFileError = z.infer<typeof fileError>;
export type EnvExec = NodeInput<"env.exec">;
export type EnvExecAttach = NodeInput<"env.execAttach">;
export type EnvExecAttachResult = z.infer<typeof envExecAttachResult>;
export type EnvExecKill = NodeInput<"env.execKill">;
export type EnvExecKillResult = z.infer<typeof envExecKillResult>;
export type ExecRecord = z.infer<typeof execRecord>;
export type CheckoutEnvironment = NodeInput<"checkout.environment">;
export type CheckoutEnvironmentResult = z.infer<typeof checkoutEnvironmentResult>;

/** The server's durable session commands (its `node_command_outbox` rows): the submitted work the outbox
 * delivers in order and replays when an outcome is unknown, without what the server resolves from its
 * rows when it sends one (binding, branch, lane seed, runtime). Each is sent as the node method its `op`
 * names. Abort, resumePending and close are not commands: the server calls them directly. */
export const nodeCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("session.prompt"), ...sessionInputFields }),
  z.object({ op: z.literal("session.steer"), ...sessionInputFields }),
  /** Changes the model (and thinking level when given) Pi's lane uses from its next LLM turn. */
  z.object({ op: z.literal("session.setModel"), sessionId: id, ...sessionModelFields }),
]);
/** Delivery preserves the validated wire result, rather than translating it into another vocabulary. A
 * failure is a `NodeError` whose message is not bounded (the server adds context to a transport failure)
 * and whose extra fields are dropped rather than refused. */
export const nodeResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.union([sessionInputResult, sessionSetModelResult]) }),
  z.object({ ok: z.literal(false), error: z.object({ ...nodeError.shape, message: z.string() }) }),
]);
export type NodeCommand = z.infer<typeof nodeCommand>;
export type NodeResult = z.infer<typeof nodeResult>;
