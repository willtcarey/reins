import { z } from "zod";
import type { AgentRuntimeEvent, FinalReply, ImageReferenceBlock } from "./events.js";
import { contentImages } from "./event-images.js";
import { HEARTBEAT_METHOD } from "./peer.js";
import { imageMimeType, MAX_ATTACHMENT_BYTES, promptContent, sessionConfiguration } from "./contract.js";

/** Wire protocol version, negotiated in `node.hello`; independent of how the server stores commands. */
export const protocolVersion = 1;
/** Every wire method name. Named for what is happening, not which side serves it: commands are
 * imperatives, requests name the resource, durable reports are past tense; `node.` is connection-level. */
export const methods = {
  nodeHello: "node.hello", nodePing: HEARTBEAT_METHOD, sessionProvision: "session.provision",
  sessionPrompt: "session.prompt", sessionSteer: "session.steer", sessionSetModel: "session.setModel",
  sessionAbort: "session.abort", sessionResumePending: "session.resumePending",
  sessionHydrate: "session.hydrate", sessionSnapshot: "session.snapshot", sessionDelete: "session.delete",
  sessionCommitted: "session.committed", sessionStarted: "session.started", sessionSettled: "session.settled",
  attachmentFetch: "attachment.fetch", attachmentStore: "attachment.store", sessionEvent: "session.event",
  scriptExecute: "script.execute", scriptSearch: "script.search", scriptCancel: "script.cancel",
  projectCreateTask: "project.createTask", skillsList: "skills.list",
  credentialsGet: "credentials.get", credentialsRefresh: "credentials.refresh", credentialsList: "credentials.list",
} as const;
/** Server→node methods are negotiated capabilities. */
export const capability = z.enum([methods.sessionProvision, methods.sessionPrompt, methods.sessionSteer,
  methods.sessionSetModel, methods.sessionAbort, methods.sessionResumePending, methods.sessionHydrate, methods.sessionDelete, methods.skillsList]);
export type Capability = z.infer<typeof capability>;
export const helloParams = z.strictObject({
  minVersion: z.number().int().positive(), maxVersion: z.number().int().positive(),
  capabilities: z.array(z.string().min(1).max(128)).max(16),
  /** The connecting node's ID: the server serves the connection only for a node it knows (a `nodes` row). */
  nodeId: z.string().min(1).max(128),
}).refine(value => value.minVersion <= value.maxVersion);
export const readyResult = z.strictObject({
  version: z.literal(1), capabilities: z.array(capability).max(16), epoch: z.string().uuid(),
});
/** The immutable node session binding the server resolves from its product rows on every session
 * command; the node stores it at provision/hydrate and verifies every later command against it. */
export const binding = z.strictObject({
  sourceId: z.number().int().positive(), cwd: z.string().min(1).max(4096),
  createdAt: z.string().min(1).max(128), parentSessionId: z.string().min(1).nullable(),
});
export type NodeSessionBinding = z.infer<typeof binding>;
const wireModel = sessionConfiguration.shape.model.unwrap();
/** Server→node session commands carry the session and its binding. The node keeps no per-command state:
 * a replay after an unknown outcome converges on the command's own state (see node-contract.md). */
const sessionCommand = { epoch: z.string().uuid(), sessionId: z.string().min(1).max(128), binding };
/** The session's configuration is part of the stored provision command, so a replay carries the same bytes. */
export const provisionParams = z.strictObject({ ...sessionCommand, configuration: sessionConfiguration });
export const provisionResult = z.strictObject({ provisioned: z.literal(true) });
/** Node→server methods are base v1, not capability-gated: the server serves them only on a
 * negotiated connection for the epoch it issued. `session.committed` is a durable report: the node
 * replays a batch until acknowledged; the server dedupes by startSeq. */
/** Attachments cross in raw-byte chunks so a 10 MiB upload fits 1 MiB frames after base64. */
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;
export const sessionCommittedParams = z.strictObject({
  epoch: z.string().uuid(), sessionId: z.string().min(1).max(128),
  startSeq: z.number().int().positive(), writesJson: z.string().min(2),
});
export const sessionCommittedResult = z.strictObject({ acknowledged: z.literal(true) });
export const attachmentFetchParams = z.strictObject({
  epoch: z.string().uuid(), sessionId: z.string().min(1).max(128), attachmentId: z.string().min(1).max(128),
  offset: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
});
/** `data` is base64 of bytes [offset, offset + ATTACHMENT_CHUNK_BYTES); byteSize and sha256 describe the whole attachment. */
export const attachmentFetchResult = z.strictObject({
  attachment: z.strictObject({
    data: z.string().max(Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/),
    mimeType: z.string().min(1).max(128), byteSize: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/), filename: z.string().max(4096).optional(),
    width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  }).nullable(),
});
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const attachmentMetadata = {
  mimeType: z.string().min(1).max(128), byteSize: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES), sha256,
  filename: z.string().max(4096).optional(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
};
/** Image MIME types an attachment may have; the node checks these limits before it references an image. */
export const ATTACHMENT_IMAGE_MIME_TYPES: readonly string[] = imageMimeType.options;
/** Attachment IDs appear in URLs and transcripts; node-assigned ones are `att_<uuid>`. */
const attachmentId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/);
/** Node-created image bytes (e.g. a tool result reading a PNG) cross as a durable, idempotent upload
 * from the node's session outbox, never inside a live event. The node assigned `attachmentId` when it
 * referenced the image; the server stores the bytes under exactly that ID for the session. `data` is
 * base64 of raw bytes [offset, offset + ATTACHMENT_CHUNK_BYTES); the metadata describes the whole
 * attachment. The server keeps a partial upload per connection keyed by (sessionId, attachmentId) and
 * answers `nextOffset` until the last chunk, which it verifies (size and sha256) and stores; an ID the
 * server already holds with the same content answers `stored` at once (replays are idempotent), and
 * different content under that ID is rejected. */
export const attachmentStoreParams = z.strictObject({
  epoch: z.string().uuid(), sessionId: z.string().min(1).max(128), attachmentId, ...attachmentMetadata,
  offset: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
  data: z.string().max(Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
/** Prompt/steer `content` (`promptContent`, shared with the stored command): text and server attachment
 * references only (the node fetches the bytes with `attachment.fetch`), never inline bytes. A replay is
 * recognized by Pi's durable input ID (`clientId`). */
export const sessionInputParams = z.strictObject({
  ...sessionCommand, clientId: z.string().min(1).max(128), content: promptContent, sourceSessionId: z.string().min(1).max(128).nullable(),
});
export const sessionInputResult = z.strictObject({ inputId: z.string().min(1) });
export const sessionSetModelParams = z.strictObject({ ...sessionCommand, ...wireModel.shape, thinkingLevel: z.string().min(1).max(32).optional() });
export const sessionSetModelResult = z.strictObject({ modelSet: z.literal(true) });
/** Immediate controls: never queued or replayed. */
export const sessionControlParams = z.strictObject(sessionCommand);
export const sessionAbortResult = z.strictObject({ aborted: z.boolean() });
export const sessionResumeResult = z.strictObject({ started: z.boolean() });
/** `skills.list`: the skills a source's checkout offers (for prompt suggestions), read by the node at
 * the source's `cwd` (the path the server resolves for the source, as in a session binding). Read-only
 * and never queued: a server with no connected node answers without it. Bounded: the node sends at most
 * `MAX_LISTED_SKILLS`. */
export const MAX_LISTED_SKILLS = 1024;
export const skillsListParams = z.strictObject({ epoch: z.string().uuid(), sourceId: z.number().int().positive(), cwd: z.string().min(1).max(4096) });
export const skillInfo = z.strictObject({ name: z.string().min(1).max(128), description: z.string().max(4096) });
export const skillsListResult = z.strictObject({ skills: z.array(skillInfo).max(MAX_LISTED_SKILLS) });
/** Session relocation (see node-contract.md *Session relocation*). A copy of a session is identified by
 * its next harness seq, per-table row counts and a sha256 over every row in snapshot order. */
export const snapshotSummary = z.strictObject({
  harnessNextSeq: z.number().int().positive(),
  rowCounts: z.strictObject({ entries: z.number().int().min(0), values: z.number().int().min(0), lists: z.number().int().min(0), usage: z.number().int().min(0) }),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
/** `session.hydrate`: the node pulls the server's copy (`session.snapshot`) and the attachments it
 * references, writes it verbatim, checks it against `snapshot`, binds the session with `task`, then
 * answers. Replays converge: a node already holding an identical copy answers at once; a different
 * copy (a stale one from an earlier stay on this node) is replaced. */
export const sessionHydrateParams = z.strictObject({
  ...sessionCommand, task: sessionConfiguration.shape.task, snapshot: snapshotSummary,
});
export const sessionHydrateResult = z.strictObject({ hydrated: z.literal(true) });
/** `session.delete`: the session was deleted on the server; the node drops whatever it holds for it
 * (aborting a run, closing its runtime, deleting its copy, outbox and attachment cache). No binding: the
 * server no longer has one. Idempotent: a node holding nothing answers the same. */
export const sessionDeleteParams = z.strictObject({ epoch: z.string().uuid(), sessionId: z.string().min(1).max(128) });
export const sessionDeleteResult = z.strictObject({ deleted: z.literal(true) });
const snapshotText = z.string().max(64 * 1024 * 1024);
export const snapshotRow = z.discriminatedUnion("table", [
  z.strictObject({ table: z.literal("entry"), seq: z.number().int().min(0), harnessId: z.string().min(1), parentHarnessId: z.string().min(1).nullable(),
    role: z.string().min(1), messageJson: snapshotText, createdAt: z.string().min(1) }),
  z.strictObject({ table: z.literal("value"), seq: z.number().int().min(0), namespace: z.string(), key: z.string(), valueJson: snapshotText }),
  z.strictObject({ table: z.literal("list"), seq: z.number().int().min(0), namespace: z.string(), key: z.string(), valueJson: snapshotText }),
  z.strictObject({ table: z.literal("usage"), seq: z.number().int().min(0), id: z.string().min(1), entryId: z.string().nullable(), adjustment: z.number().int(),
    usageJson: snapshotText, detailsJson: snapshotText.nullable() }),
]);
/** Node→server request: one page of the server's copy of a session from `fromSeq` (bounded rows and
 * bytes, never splitting a seq; `nextSeq` null after the last page), with the copy's current summary. */
export const sessionSnapshotParams = z.strictObject({ epoch: z.string().uuid(), sessionId: z.string().min(1).max(128), fromSeq: z.number().int().min(0) });
export const sessionSnapshotResult = z.strictObject({
  summary: snapshotSummary, rows: z.array(snapshotRow), nextSeq: z.number().int().min(0).nullable(),
});
/** The reference that replaces the inline block in session events. */
export const imageReference = z.strictObject({
  type: z.literal("image"), attachmentId: z.string().min(1).max(128), mimeType: z.string().min(1).max(128),
  byteSize: z.number().int().min(0), sha256: z.string().max(128).optional(), filename: z.string().max(4096).optional(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
});
export const storedAttachment = z.strictObject({ attachmentId: z.string().min(1).max(128), ...attachmentMetadata });
export const attachmentStoreResult = z.union([
  z.strictObject({ stored: z.literal(true) }),
  z.strictObject({ nextOffset: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES) }),
]);
const runId = z.string().min(1).max(128);
/** Run lifecycle reports are durable like `session.committed`: the node stores each one in its
 * per-session outbox behind the commits that preceded it, replays it until acknowledged, and the
 * server applies it once: an identical replay of the last applied report (or a `started` for the run
 * that last settled) is acknowledged without effects. A resumed run reports `started` again with the
 * same runId, which the server treats as a replay. */
export const sessionStartedParams = z.strictObject({ epoch: z.string().uuid(), sessionId: z.string().min(1).max(128), runId });
const settledReply = z.strictObject({ text: z.string().nullable(), stopReason: z.string().max(128).nullable(), errorMessage: z.string().nullable() }) satisfies z.ZodType<FinalReply>;
/** `metadata` is the runtime's model selection at settlement. `reply` is the final assistant reply,
 * read only for child sessions (null otherwise or when there is none); `replyError` replaces it when
 * the node could not read a child's transcript, so the server reports no misleading result. */
export const sessionSettledParams = z.strictObject({
  epoch: z.string().uuid(), sessionId: z.string().min(1).max(128), runId,
  status: z.enum(["completed", "failed", "aborted"]),
  error: z.strictObject({ code: z.string().optional(), message: z.string() }).optional(),
  metadata: z.strictObject({
    model: wireModel.nullable(),
    thinkingLevel: z.string().max(32).nullable(),
  }),
  reply: settledReply.nullable(),
  replyError: z.string().optional(),
});
export const acknowledgedResult = z.strictObject({ acknowledged: z.literal(true) });
/** Runtime events are relayed to browsers as the node runtime projected them; only `type` and image
 * blocks are checked here: every image in a `content` array must be an attachment reference, never
 * inline bytes (the node stores those with `attachment.store` first). */
const runtimeEventTypes = ["agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "entry_added", "tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end"] as const;
const runtimeEvent = z.looseObject({ type: z.enum(runtimeEventTypes) });
/** Live UI deltas only; run lifecycle is reported durably by `session.started`/`session.settled`. */
export const sessionEvent = z.custom<AgentRuntimeEvent<ImageReferenceBlock>>(value => runtimeEvent.safeParse(value).success
  && contentImages(value).every(block => imageReference.safeParse(block).success));
/** `session.event` is a live notification: best effort, never replayed. `seq` increases by one per
 * session event the node emits (dropped ones included), so a receiver can detect gaps. */
export const sessionEventParams = z.strictObject({
  epoch: z.string().uuid(), sessionId: z.string().min(1).max(128), seq: z.number().int().min(0), event: sessionEvent,
});
/** Agent tool calls the server serves for the calling session (`sessionId`). The server derives the
 * project/task scope from its own session row and never accepts scope from the node; strict params
 * reject any extra field. `callId` correlates a `script.cancel` notification with its `script.execute`. */
const toolSession = { epoch: z.string().uuid(), sessionId: z.string().min(1).max(128) };
export const scriptExecuteParams = z.strictObject({ ...toolSession, callId: z.string().min(1).max(128), code: z.string() });
/** A script that throws is a completed call: its error message reaches the model unchanged. */
export const scriptExecuteResult = z.union([
  z.strictObject({ ok: z.literal(true), text: z.string() }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
/** Best-effort notification: the server aborts the script's signal (e.g. `sessions.wait`); synchronous script code is not interruptible. */
export const scriptCancelParams = z.strictObject({ ...toolSession, callId: z.string().min(1).max(128) });
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
const providerId = z.string().min(1).max(128);
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
export const credentialsParams = z.strictObject({ epoch: z.string().uuid(), providerId });
/** `credentials.get` and `credentials.refresh`; null when the provider is logged out on the server. */
export const credentialResult = z.strictObject({ credential: nodeCredential.nullable() });
export const credentialsListParams = z.strictObject({ epoch: z.string().uuid() });
export const credentialsListResult = z.strictObject({
  credentials: z.array(z.strictObject({ providerId, type: z.enum(["api_key", "oauth"]) })).max(1024),
});
export type NodeCredential = z.infer<typeof nodeCredential>;
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
export type SessionEvent = z.infer<typeof sessionEvent>;
export type ScriptExecute = Omit<z.infer<typeof scriptExecuteParams>, "epoch" | "callId">;
export type ScriptExecuteResult = z.infer<typeof scriptExecuteResult>;
export type ScriptSearch = Omit<z.infer<typeof scriptSearchParams>, "epoch">;
export type ScriptSearchResult = z.infer<typeof scriptSearchResult>;
export type ProjectCreateTask = Omit<z.infer<typeof projectCreateTaskParams>, "epoch">;
export type ProjectCreateTaskResult = z.infer<typeof projectCreateTaskResult>;
export type SessionEventReport = Omit<z.infer<typeof sessionEventParams>, "epoch">;
export type Provision = Omit<z.infer<typeof provisionParams>, "epoch">;
export type SessionInput = Omit<z.infer<typeof sessionInputParams>, "epoch">;
export type SessionSetModel = Omit<z.infer<typeof sessionSetModelParams>, "epoch">;
export type SessionControl = Omit<z.infer<typeof sessionControlParams>, "epoch">;
export type SessionDelete = Omit<z.infer<typeof sessionDeleteParams>, "epoch">;
export type SessionHydrate = Omit<z.infer<typeof sessionHydrateParams>, "epoch">;
export type SessionSnapshot = z.infer<typeof sessionSnapshotResult>;
export type SkillsList = Omit<z.infer<typeof skillsListParams>, "epoch">;
export type SkillInfo = z.infer<typeof skillInfo>;
export type SkillsListResult = z.infer<typeof skillsListResult>;
export type SnapshotSummary = z.infer<typeof snapshotSummary>;
export type Ready = z.infer<typeof readyResult>;
export type Hello = z.infer<typeof helloParams>;
export type SessionCommitted = Omit<z.infer<typeof sessionCommittedParams>, "epoch">;
export type AttachmentStore = Omit<z.infer<typeof attachmentStoreParams>, "epoch" | "offset" | "data">;
export type StoredAttachment = z.infer<typeof storedAttachment>;
export type AttachmentChunk = NonNullable<z.infer<typeof attachmentFetchResult>["attachment"]>;
export type SessionStarted = Omit<z.infer<typeof sessionStartedParams>, "epoch">;
export type SessionSettled = Omit<z.infer<typeof sessionSettledParams>, "epoch">;
