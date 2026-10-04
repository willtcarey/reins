/** The methods the server serves (node→server, base protocol): run lifecycle reports, live session
 * events, attachment transfers, agent tool calls, provider credentials and session storage; their schemas
 * and the `serverMethods` table, plus the Reins tool call surface built on the tool calls. Every
 * `*Params` schema is a method's params without the connection's `epoch` (see `method-table.ts`). */
import { z } from "zod";
import { attachmentFields, base64Chunk, id, MAX_ATTACHMENT_BYTES, MAX_STREAM_CHUNK_CHARS, processExit, sessionModel, streamId } from "./fields.js";
import { nodeError } from "./errors.js";
import { MAX_ERROR_MESSAGE } from "./rpc.js";
import type { MethodInput, MethodTable } from "./method-table.js";

/** Run lifecycle reports: the node sends each one once, after the commits that preceded it, and never
 * resends it (one it could not deliver is lost; the server settles that run when the node reconnects).
 * Pi reports `started` again with the same runId for a run in progress, which the server treats as a
 * repeat. */
export const sessionStartedParams = z.strictObject({ sessionId: id, runId: id });
/** `metadata` is the runtime's model selection at settlement. `tipId` comes from Pi's durable
 * `run_end`: the server projects child replies from that exact branch, never from a newer main tip.
 * Null also represents a storage fault or interrupted run with no trustworthy completed branch. */
export const sessionSettledParams = z.strictObject({
  sessionId: id, runId: id,
  status: z.enum(["completed", "failed", "aborted"]),
  error: z.strictObject({ code: z.string().optional(), message: z.string() }).optional(),
  metadata: z.strictObject({
    model: sessionModel.nullable(),
    // Unlike a lane seed, may be empty.
    thinkingLevel: z.string().max(32).nullable(),
  }),
  tipId: id.nullable(),
});
export const acknowledgedResult = z.strictObject({ acknowledged: z.literal(true) });
/** Upper bound on one serialized session event (the local link's frame cap is larger). */
export const MAX_SESSION_EVENT_CHARS = 32 * 1024 * 1024;
/** `session.event` is a live notification: best effort, never replayed. `seq` increases by one per
 * session event the node emits (dropped ones included), so a receiver can detect gaps. `event` is the
 * node's `JSON.stringify` of one `AgentRuntimeEvent<ImageReferenceBlock>`, made after the node replaced
 * any inline image bytes (`sendableEvent`). Only this envelope is validated: the server relays `event`
 * to browsers without parsing it, so the node is what guarantees its shape and that images are
 * attachment references. `emittedAt` is the node's wall clock (`Date.now()`) when it emitted the event,
 * for latency diagnostics only (comparable across machines only as far as their clocks agree). Run
 * lifecycle is not a session event; it is reported by `session.started`/`session.settled`. */
export const sessionEventParams = z.strictObject({
  sessionId: id, seq: z.number().int().min(0),
  emittedAt: z.number().nonnegative(), event: z.string().min(2).max(MAX_SESSION_EVENT_CHARS),
});
/** Every fetch names its chunk offset. */
export const attachmentFetchParams = z.strictObject({ sessionId: id, attachmentId: id, offset: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES) });
/** `data` is base64 of bytes [offset, offset + ATTACHMENT_CHUNK_BYTES); the rest describes the whole attachment. */
export const attachmentFetchResult = z.strictObject({ attachment: z.strictObject({ data: base64Chunk, ...attachmentFields }).nullable() });
/** An uploaded attachment has at least one byte. */
const attachmentMetadata = { ...attachmentFields, byteSize: attachmentFields.byteSize.min(1) };
/** Attachment IDs appear in URLs and transcripts; node-assigned ones are `att_<uuid>`. */
const attachmentId = id.regex(/^[A-Za-z0-9_.-]+$/);
/** Node-created image bytes (e.g. a tool result reading a PNG) cross as an idempotent upload before
 * the commit that references them, never inside a live event. The node assigned `attachmentId` when it
 * referenced the image; the server stores the bytes under exactly that ID for the session. `data` is
 * base64 of raw bytes [offset, offset + ATTACHMENT_CHUNK_BYTES); the metadata describes the whole
 * attachment. The server keeps a partial upload per connection keyed by (sessionId, attachmentId) and
 * answers `nextOffset` until the last chunk, which it verifies (size and sha256) and stores; an ID the
 * server already holds with the same content answers `stored` at once (replays are idempotent), and
 * different content under that ID is rejected. */
export const attachmentStoreParams = z.strictObject({
  sessionId: id, attachmentId, ...attachmentMetadata, offset: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES), data: base64Chunk,
});
export const attachmentStoreResult = z.union([
  z.strictObject({ stored: z.literal(true) }),
  z.strictObject({ nextOffset: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES) }),
]);
/** An attachment the server holds, as `attachment.store` checks a replay against it. */
export const storedAttachment = z.strictObject({ attachmentId: id, ...attachmentMetadata });
/** Agent tool calls the server serves for the calling session (`sessionId`). The server derives the
 * project/task scope from its own session row and never accepts scope from the node; strict params
 * reject any extra field. `callId` correlates a `script.cancel` notification with its `script.execute`. */
const toolSession = { sessionId: id };
export const scriptExecuteParams = z.strictObject({ ...toolSession, callId: id, code: z.string() });
/** A script that throws is a completed call: its error message reaches the model unchanged. */
export const scriptExecuteResult = z.union([
  z.strictObject({ ok: z.literal(true), text: z.string() }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
/** Best-effort notification: the server aborts the script's signal (e.g. `sessions.wait`); synchronous script code is not interruptible. */
export const scriptCancelParams = z.strictObject({ ...toolSession, callId: id });
export const scriptSearchParams = z.strictObject({ ...toolSession, query: z.string().max(65_536) });
export const scriptSearchResult = z.strictObject({ text: z.string(), matchCount: z.number().int().min(0) });
export const projectCreateTaskParams = z.strictObject({
  ...toolSession, title: z.string(), description: z.string(),
  branchName: z.string().optional(), prompt: z.string().optional(),
});
/** `task` is the created task row as the server stores it. `sessionStarting` is true when a prompt
 * was given and the server started (fire-and-forget) a session on the task. */
export const projectCreateTaskResult = z.strictObject({
  task: z.looseObject({ id: z.number().int().positive() }), sessionStarting: z.boolean(),
});
/** Provider credentials: the server is the sole holder and the sole OAuth refresher, so a refresh
 * token never crosses the wire. An OAuth credential carries its access token, expiry and only the
 * non-secret fields Pi's providers read at request or catalog time (`OAUTH_WIRE_FIELDS`). Strict
 * schemas reject anything else, `refresh` included. */
export const OAUTH_WIRE_FIELDS = ["enterpriseUrl", "availableModelIds", "gatewayConfig"] as const;
export const nodeCredential = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("api_key"), key: z.string().max(65_536).optional(), env: z.record(z.string(), z.string()).optional() }),
  z.strictObject({
    type: z.literal("oauth"), access: z.string().max(65_536), expires: z.number(),
    // GitHub Copilot: enterprise domain (base URL) and the account's model list; Radius: gateway config.
    enterpriseUrl: z.string().max(4096).optional(), availableModelIds: z.array(z.string().max(256)).max(4096).optional(),
    gatewayConfig: z.unknown().optional(),
  }),
]);
export const credentialsParams = z.strictObject({ providerId: id });
/** `credentials.get` and `credentials.refresh`; null when the provider is logged out on the server. */
export const credentialResult = z.strictObject({ credential: nodeCredential.nullable() });
export const credentialsListParams = z.strictObject({});
export const credentialsListResult = z.strictObject({
  credentials: z.array(z.strictObject({ providerId: id, type: z.enum(["api_key", "oauth"]) })).max(1024),
});
export type NodeCredential = z.infer<typeof nodeCredential>;
/** Session storage over the wire (ADR-015): a node's Pi runtime reads and commits a session's AgentHarness storage on the server, which serves both
 * from Pi's storage on its own database. `storage.read` is one read method of Pi's `Storage` (`op`, with its
 * arguments as `args`); `storage.commit` carries Pi's `Write[]` as the node produced them and returns Pi's
 * `CommitResult`. Reins-owned structure is strict. Pi's own bodies (an entry's payload, values, list
 * elements, usage) cross as the JSON Pi's storage wrote and reads, with only their envelope checked here:
 * the server's Pi storage validates writes. `Map`s cross as arrays and absent results as null. */
const storageSession = { sessionId: id };
const storageSeq = z.number().int().min(0);
const storageCursor = z.strictObject({ seq: storageSeq });
const entryType = z.enum(["message", "compaction", "branch_summary", "custom"]);
const entryId = z.string().min(1);
/** Pi's entry envelope; the rest of an entry is its type's payload. */
const entryEnvelope = z.looseObject({ id: entryId, parentId: entryId.nullable(), type: entryType, customType: z.string().optional() });
const storedEntryEnvelope = entryEnvelope.extend({ seq: storageSeq, timestamp: z.number() });
/** An entry to store (Pi's `NewEntry`) and a stored one (Pi's `Entry`): envelope checked, payload passed through as is. */
export interface NewStorageEntry { id: string; parentId: string | null; type: z.infer<typeof entryType>; customType?: string }
export interface StorageEntry extends NewStorageEntry { seq: number; timestamp: number }
const newStorageEntry = z.custom<NewStorageEntry>(value => entryEnvelope.safeParse(value).success);
const storageEntry = z.custom<StorageEntry>(value => storedEntryEnvelope.safeParse(value).success);
/** Pi-owned object bodies (usage totals). */
const piObject = z.custom<object>(value => typeof value === "object" && value !== null && !Array.isArray(value));
const storageAddress = { namespace: z.string().min(1), key: z.string() };
const usageRow = { id: entryId, usage: piObject, adjustment: z.boolean(), entryId: z.string().optional(), details: z.unknown().optional() };
const branchScan = z.strictObject({
  start: entryId, stopAtType: entryType.optional(), stopAtId: z.string().optional(), type: entryType.optional(), customType: z.string().optional(),
  order: z.enum(["newestFirst", "oldestFirst"]).optional(), limit: z.number().int().min(0).optional(), cursor: storageCursor.optional(),
});
const seqRange = { fromSeq: storageSeq.optional(), toSeq: storageSeq.optional(), order: z.enum(["asc", "desc"]).optional(), limit: z.number().int().min(0).optional() };
const storageRead = <Op extends string, Args extends z.ZodType>(op: Op, args: Args) => z.strictObject({ ...storageSession, op: z.literal(op), args });
export const storageReadParams = z.discriminatedUnion("op", [
  storageRead("getEntries", z.strictObject({ ids: z.array(entryId) })),
  storageRead("getValue", z.strictObject(storageAddress)),
  storageRead("scanValues", z.strictObject(storageAddress)),
  storageRead("readList", z.strictObject({ ...storageAddress, options: z.strictObject({
    cursor: storageCursor.optional(), order: z.enum(["asc", "desc"]).optional(), limit: z.number().int().positive().optional(),
  }).optional() })),
  storageRead("scanBranch", branchScan),
  storageRead("scanBranchStructure", branchScan),
  storageRead("scanEntries", z.strictObject({ type: entryType.optional(), customType: z.string().optional(), ...seqRange })),
  storageRead("scanUsage", z.strictObject(seqRange)),
  storageRead("getStats", z.strictObject({})),
]);
const storedValue = z.strictObject({ ...storageAddress, value: z.unknown(), seq: storageSeq });
const sessionStats = z.strictObject({ messageCount: z.number().int().min(0), usage: piObject });
/** Each result names its `op`. `getEntries` lists the entries found in request order (Pi's `Map`); `getValue`
 * is null for no value (Pi's `undefined`); a value's address crosses as its namespace and key. */
export const storageReadResult = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("getEntries"), entries: z.array(storageEntry) }),
  z.strictObject({ op: z.literal("getValue"), value: storedValue.nullable() }),
  z.strictObject({ op: z.literal("scanValues"), values: z.array(storedValue) }),
  z.strictObject({ op: z.literal("readList"), elements: z.array(z.strictObject({ seq: storageSeq, value: z.unknown() })) }),
  z.strictObject({ op: z.literal("scanBranch"), entries: z.array(storageEntry) }),
  z.strictObject({ op: z.literal("scanBranchStructure"), entries: z.array(z.strictObject({
    id: entryId, parentId: entryId.nullable(), seq: storageSeq, timestamp: z.number(), type: entryType, customType: z.string().optional(),
  })) }),
  z.strictObject({ op: z.literal("scanEntries"), entries: z.array(storageEntry) }),
  z.strictObject({ op: z.literal("scanUsage"), rows: z.array(z.strictObject({ ...usageRow, seq: storageSeq })) }),
  z.strictObject({ op: z.literal("getStats"), stats: sessionStats }),
]);
const storageWrite = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("entry"), entry: newStorageEntry }),
  z.strictObject({ kind: z.literal("usage"), row: z.strictObject(usageRow) }),
  z.discriminatedUnion("op", [
    z.strictObject({ kind: z.literal("value"), op: z.literal("set"), ...storageAddress, value: z.unknown() }),
    z.strictObject({ kind: z.literal("value"), op: z.literal("delete"), ...storageAddress }),
  ]),
  z.discriminatedUnion("op", [
    z.strictObject({ kind: z.literal("list"), op: z.literal("append"), ...storageAddress, value: z.unknown() }),
    z.strictObject({ kind: z.literal("list"), op: z.literal("delete"), ...storageAddress }),
  ]),
]);
/** One Pi commit, applied by the server in one transaction (Pi's `prepareStorageCommit` and
 * `validateCommittedWrites` against its copy). A commit Pi refuses (a duplicate ID, a missing parent: a
 * stale or concurrent writer) is a definite `invalid_request` rejection, never retried. */
export const storageCommitParams = z.strictObject({ ...storageSession, writes: z.array(storageWrite) });
export const storageCommitResult = z.strictObject({ firstSeq: storageSeq, seqs: z.array(storageSeq), timestamp: z.number(), stats: sessionStats });

/** Streams the server opened on this connection (see `streams.ts`), as notifications in stream order:
 * `stream.data` carries the next chunk, `offset` being the absolute byte offset of its first byte in the
 * stream: text (its UTF-8 bytes), or base64 of raw bytes for a binary stream (`encoding`). `stream.end`
 * is the stream's last frame: `error` says the source failed; `exit` is how a process stream's process
 * ended (a non-zero exit is not a stream failure). */
export const streamDataParams = z.strictObject({
  streamId, offset: z.number().int().min(0), data: z.string().min(1).max(MAX_STREAM_CHUNK_CHARS), encoding: z.literal("base64").optional(),
}).refine(({ data, encoding }) => encoding === undefined || /^[A-Za-z0-9+/]*={0,2}$/.test(data), "Invalid base64");
export const streamEndParams = z.strictObject({ streamId, error: z.string().max(MAX_ERROR_MESSAGE).optional(), exit: processExit.optional() });

/** Bound on node→server calls (lifecycle reports, storage, attachments, credentials). */
const SERVER_CALL_TIMEOUT_MS = 30_000;
/** Agent tool calls are never retried automatically: execute and createTask may have side effects.
 * Scripts may await several `sessions.wait` calls (each up to 30s), so execute gets a longer bound. */
const SCRIPT_EXECUTE_TIMEOUT_MS = 5 * 60_000;
const SCRIPT_SEARCH_TIMEOUT_MS = 30_000;
const CREATE_TASK_TIMEOUT_MS = 60_000;
/** A refresh may wait behind another refresh of the same login on the server, then call the provider
 * (Pi bounds each provider refresh at 15s). */
const CREDENTIAL_REFRESH_TIMEOUT_MS = 60_000;
/** Node→server methods are base protocol, not capability-gated: the server serves them only on a
 * negotiated connection for the epoch it issued. A rejection with `errorData` may carry a `NodeError`
 * (`not_owner` when the session's source is not on the calling node); the others carry a message only. */
export const serverMethods = {
  "session.started": { params: sessionStartedParams, result: acknowledgedResult, errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS },
  "session.settled": { params: sessionSettledParams, result: acknowledgedResult, errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS },
  "session.event": { params: sessionEventParams },
  "attachment.fetch": { params: attachmentFetchParams, result: attachmentFetchResult, timeoutMs: SERVER_CALL_TIMEOUT_MS },
  "attachment.store": { params: attachmentStoreParams, result: attachmentStoreResult, errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS },
  "script.execute": { params: scriptExecuteParams, result: scriptExecuteResult, timeoutMs: SCRIPT_EXECUTE_TIMEOUT_MS },
  "script.cancel": { params: scriptCancelParams },
  "script.search": { params: scriptSearchParams, result: scriptSearchResult, timeoutMs: SCRIPT_SEARCH_TIMEOUT_MS },
  "project.createTask": { params: projectCreateTaskParams, result: projectCreateTaskResult, timeoutMs: CREATE_TASK_TIMEOUT_MS },
  "credentials.get": { params: credentialsParams, result: credentialResult, errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS },
  "credentials.refresh": { params: credentialsParams, result: credentialResult, errorData: nodeError, timeoutMs: CREDENTIAL_REFRESH_TIMEOUT_MS },
  "credentials.list": { params: credentialsListParams, result: credentialsListResult, errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS },
  "storage.read": { params: storageReadParams, result: storageReadResult, errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS },
  "storage.commit": { params: storageCommitParams, result: storageCommitResult, errorData: nodeError, timeoutMs: SERVER_CALL_TIMEOUT_MS },
  "stream.data": { params: streamDataParams },
  "stream.end": { params: streamEndParams },
} satisfies MethodTable;

type ServerInput<M extends keyof typeof serverMethods> = MethodInput<(typeof serverMethods)[M]>;
export type SessionStarted = ServerInput<"session.started">;
export type SessionSettled = ServerInput<"session.settled">;
export type SessionEventReport = ServerInput<"session.event">;
export type AttachmentStore = Omit<ServerInput<"attachment.store">, "offset" | "data">;
export type StoredAttachment = z.infer<typeof storedAttachment>;
export type AttachmentChunk = NonNullable<z.infer<typeof attachmentFetchResult>["attachment"]>;
export type ScriptExecute = Omit<ServerInput<"script.execute">, "callId">;
export type ScriptExecuteResult = z.infer<typeof scriptExecuteResult>;
export type ScriptSearch = ServerInput<"script.search">;
export type ScriptSearchResult = z.infer<typeof scriptSearchResult>;
export type ProjectCreateTask = ServerInput<"project.createTask">;
export type ProjectCreateTaskResult = z.infer<typeof projectCreateTaskResult>;
/** A `storage.read` request (one member per `op`). */
export type StorageRead = ServerInput<"storage.read">;
export type StorageReadResult = z.infer<typeof storageReadResult>;
export type StorageCommit = ServerInput<"storage.commit">;
export type StorageCommitResult = z.infer<typeof storageCommitResult>;
export type StreamData = ServerInput<"stream.data">;
export type StreamEnd = ServerInput<"stream.end">;

/** A provider credential as the server stores it (Pi's `Credential`: an API key, or OAuth tokens with
 * provider-specific extra fields). Declared structurally so the protocol does not depend on Pi. */
export type ServerCredential =
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | { type: "oauth"; access: string; expires: number; [field: string]: unknown };
/** The server's stored credential as it may cross to a node: API keys whole (key and provider env),
 * OAuth without its refresh token or any field outside `OAUTH_WIRE_FIELDS`. */
export function toNodeCredential(credential: ServerCredential | undefined): NodeCredential | null {
  if (!credential) return null;
  if (credential.type === "api_key") return { type: "api_key", ...(credential.key === undefined ? {} : { key: credential.key }), ...(credential.env ? { env: credential.env } : {}) };
  const extra = Object.fromEntries(OAUTH_WIRE_FIELDS.filter(name => credential[name] !== undefined).map(name => [name, credential[name]]));
  return nodeCredential.parse({ type: "oauth", access: credential.access, expires: credential.expires, ...extra });
}
export type CredentialInfo = z.infer<typeof credentialsListResult>["credentials"][number];

/** The Reins application tools' model-visible names. The node defines the tools (descriptions and
 * parameter schemas, `@reins/node/reins-tools`); the server serves the operation each one forwards to
 * (`project.createTask`, `script.search`, `script.execute`). */
export const reinsToolNames = { createTask: "create_task", search: "search", execute: "execute" } as const;

export interface CreateTaskInput { title: string; description: string; branchName?: string; prompt?: string }

/** Session-bound server operations the Reins tools call. On the node they cross the connection; the
 * server implements them for a session (`serverToolCalls`). A thrown plain `Error` is a definitive
 * rejection whose message reaches the model. */
export interface ReinsToolCalls {
  executeScript(code: string, signal?: AbortSignal): Promise<ScriptExecuteResult>;
  searchScript(query: string, signal?: AbortSignal): Promise<ScriptSearchResult>;
  createTask(input: CreateTaskInput, signal?: AbortSignal): Promise<ProjectCreateTaskResult>;
}
