/** The methods the node serves (server→node, the negotiated capabilities): their schemas and the
 * `nodeMethods` table, plus the server's durable vocabulary for the session work among them (the
 * commands `node_command_outbox` stores and their results). Every `*Params` schema is a method's params
 * without the connection's `epoch` (see `method-table.ts`). */
import { z } from "zod";
import { base64Chunk, branchName, id, promptContent, sessionModel, sessionRuntime, sourceCheckout, streamId, thinkingLevel } from "./fields.js";
import { nodeError } from "./errors.js";
import { methodNames, type MethodInput, type MethodTable } from "./method-table.js";

/** The node session binding the server resolves from its product rows on every session command: where
 * the session runs (its source and checkout) and the identity Pi's session is created with. The node
 * stores nothing: it opens the session's runtime from the binding the command carries. */
export const binding = z.strictObject({
  sourceId: z.number().int().positive(), cwd: z.string().min(1).max(4096),
  createdAt: z.string().min(1).max(128), parentSessionId: z.string().min(1).nullable(),
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
/** Immediate controls, called directly by the server and never queued or replayed. Abort never opens a
 * runtime; resuming may. */
export const sessionControlParams = z.strictObject(sessionCommand);
export const sessionResumeParams = z.strictObject(openingCommand);
/** `session.close`: an immediate control telling the node the session no longer runs there (it was moved
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

/** `stream.cancel`: the server no longer wants a stream it opened on this connection (its consumer
 * cancelled, or it failed on the server). The node stops the stream's source and sends nothing more for
 * it; an unknown stream is ignored. A node advertises this capability when it serves streams. */
export const streamCancelParams = z.strictObject({ streamId });

/** Server→node methods: the negotiated capabilities (`capability`); the node advertises each one it
 * serves. A node rejection carries a `NodeError` as `data`. The server bounds each call itself (its
 * caller's timeout). */
export const nodeMethods = {
  "session.prompt": { params: sessionInputParams, result: sessionInputResult, errorData: nodeError },
  "session.steer": { params: sessionInputParams, result: sessionInputResult, errorData: nodeError },
  "session.setModel": { params: sessionSetModelParams, result: sessionSetModelResult, errorData: nodeError },
  "session.abort": { params: sessionControlParams, result: sessionAbortResult, errorData: nodeError },
  "session.resumePending": { params: sessionResumeParams, result: sessionResumeResult, errorData: nodeError },
  "session.close": { params: sessionCloseParams, result: sessionCloseResult, errorData: nodeError },
  "skills.list": { params: skillsListParams, result: skillsListResult, errorData: nodeError },
  "process.run": { params: processRunParams, result: processRunResult, errorData: nodeError },
  "fs.list": { params: fsListParams, result: fsListResult, errorData: nodeError },
  "fs.read": { params: fsReadParams, result: fsReadResult, errorData: nodeError },
  "fs.write": { params: fsWriteParams, result: fsWriteResult, errorData: nodeError },
  "stream.cancel": { params: streamCancelParams },
} satisfies MethodTable;
/** Server→node methods are negotiated capabilities. */
export const capability = z.enum(methodNames(nodeMethods));
export type Capability = z.infer<typeof capability>;

type NodeInput<M extends keyof typeof nodeMethods> = MethodInput<(typeof nodeMethods)[M]>;
export type SessionInput = NodeInput<"session.prompt">;
export type SessionSetModel = NodeInput<"session.setModel">;
export type SessionControl = NodeInput<"session.abort">;
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
export type DirectoryEntry = z.infer<typeof directoryEntry>;

/** The server's durable session commands (its `node_command_outbox` rows): the submitted work the outbox
 * delivers in order and replays when an outcome is unknown, without what the server resolves from its
 * rows when it sends one (binding, branch, lane seed, runtime). Each is sent as the node method its `op`
 * names. Immediate controls (abort, resumePending, close) are not commands: the server calls them
 * directly. */
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
