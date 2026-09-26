import { z } from "zod";
import type { AgentRuntimeEvent } from "../runtime/types.js";

/** Wire v1 is independent of the in-process semantic contract. */
export const protocolVersion = 1;
/** Every wire method name. Named for what is happening, not which side serves it: commands are
 * imperatives, requests name the resource, durable reports are past tense; `node.` is connection-level. */
export const methods = {
  nodeHello: "node.hello", sessionProvision: "session.provision", sessionStatus: "session.status",
  sessionCommitted: "session.committed", sessionStarted: "session.started", sessionSettled: "session.settled",
  attachmentFetch: "attachment.fetch", sessionEvent: "session.event",
  scriptExecute: "script.execute", scriptSearch: "script.search", scriptCancel: "script.cancel",
  projectCreateTask: "project.createTask",
} as const;
/** Server→node methods are negotiated capabilities. */
export const capability = z.enum([methods.sessionProvision, methods.sessionStatus]);
export type Capability = z.infer<typeof capability>;
export const helloParams = z.strictObject({
  minVersion: z.number().int().positive(), maxVersion: z.number().int().positive(),
  capabilities: z.array(z.string().min(1).max(128)).max(16), instanceId: z.string().min(1).max(128),
}).refine(value => value.minVersion <= value.maxVersion);
export const readyResult = z.strictObject({
  version: z.literal(1), capabilities: z.array(capability).max(16), epoch: z.string().uuid(),
});
export const binding = z.strictObject({
  sourceId: z.number().int().positive(), cwd: z.string().min(1).max(4096),
  createdAt: z.string().min(1).max(128), parentSessionId: z.string().min(1).nullable(),
});
const wireModel = z.strictObject({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) });
/** The session's configuration, frozen by the server at creation: Pi's initial model/thinking level
 * (null thinking: off) and the task snapshot for the system prompt and branch checkout (null: scratch).
 * It is part of the provision command, so a replay carries the same bytes. */
export const provisionConfiguration = z.strictObject({
  model: wireModel.nullable(),
  thinkingLevel: z.string().min(1).max(32).nullable(),
  task: z.strictObject({ title: z.string(), description: z.string().nullable(), branchName: z.string().min(1).max(1024) }).nullable(),
});
export const provisionParams = z.strictObject({
  epoch: z.string().uuid(), sessionId: z.string().min(1).max(128),
  commandId: z.string().min(1).max(128), binding, configuration: provisionConfiguration,
});
export const provisionResult = z.strictObject({ provisioned: z.literal(true) });
export const statusParams = z.strictObject({ epoch: z.string().uuid(), sessionId: z.string().min(1).max(128) });
export const statusResult = z.strictObject({ provisioned: z.boolean() });
/** Node→server methods are base v1, not capability-gated: the server serves them only on a
 * negotiated connection for the epoch it issued. `session.committed` is a durable report: the node
 * replays a batch until acknowledged; the server dedupes by startSeq. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Attachments cross in raw-byte chunks so a 10 MiB upload fits 1 MiB frames after base64. */
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;
export const sessionCommittedParams = z.strictObject({
  epoch: z.string().uuid(), sessionId: z.string().min(1).max(128),
  startSeq: z.number().int().positive(), writesJson: z.string().min(2),
});
export const sessionCommittedResult = z.strictObject({ acknowledged: z.literal(true) });
export const attachmentFetchParams = z.strictObject({
  epoch: z.string().uuid(), sessionId: z.string().min(1).max(128), attachmentId: z.string().min(1).max(128),
  offset: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES).default(0),
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
const runId = z.string().min(1).max(128);
/** Run lifecycle reports are durable like `session.committed`: the node stores each one in its
 * per-session outbox behind the commits that preceded it, replays it until acknowledged, and the
 * server applies it once per (sessionId, runId, kind). A resumed run reports `started` again with
 * the same runId; the server treats an identical report as a replay. */
export const sessionStartedParams = z.strictObject({ epoch: z.string().uuid(), sessionId: z.string().min(1).max(128), runId });
export const finalReply = z.strictObject({ text: z.string().nullable(), stopReason: z.string().max(128).nullable(), errorMessage: z.string().nullable() });
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
  reply: finalReply.nullable(),
  replyError: z.string().optional(),
});
export const acknowledgedResult = z.strictObject({ acknowledged: z.literal(true) });
/** Runtime events are relayed to browsers as the node runtime projected them; only `type` is checked here. */
export const runtimeEventTypes = ["agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "entry_added", "tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end"] as const;
const runtimeEvent = z.looseObject({ type: z.enum(runtimeEventTypes) });
/** Live UI deltas only; run lifecycle is reported durably by `session.started`/`session.settled`. */
export const sessionEvent = z.custom<AgentRuntimeEvent>(value => runtimeEvent.safeParse(value).success);
/** `session.event` is a live notification: best effort, never replayed. `seq` increases by one per
 * session event the node emits (dropped ones included), so a receiver can detect gaps. */
export const sessionEventParams = z.strictObject({
  epoch: z.string().uuid(), sessionId: z.string().min(1).max(128), seq: z.number().int().positive(), event: sessionEvent,
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
export type SessionEvent = z.infer<typeof sessionEvent>;
export type ScriptExecute = Omit<z.infer<typeof scriptExecuteParams>, "epoch" | "callId">;
export type ScriptExecuteResult = z.infer<typeof scriptExecuteResult>;
export type ScriptSearch = Omit<z.infer<typeof scriptSearchParams>, "epoch">;
export type ScriptSearchResult = z.infer<typeof scriptSearchResult>;
export type ProjectCreateTask = Omit<z.infer<typeof projectCreateTaskParams>, "epoch">;
export type ProjectCreateTaskResult = z.infer<typeof projectCreateTaskResult>;
export type SessionEventReport = Omit<z.infer<typeof sessionEventParams>, "epoch">;
export type Provision = Omit<z.infer<typeof provisionParams>, "epoch">;
export type Ready = z.infer<typeof readyResult>;
export type Hello = z.infer<typeof helloParams>;
export type Status = z.infer<typeof statusResult>;
export type SessionCommitted = Omit<z.infer<typeof sessionCommittedParams>, "epoch">;
export type AttachmentChunk = NonNullable<z.infer<typeof attachmentFetchResult>["attachment"]>;
export type SessionStarted = Omit<z.infer<typeof sessionStartedParams>, "epoch">;
export type SessionSettled = Omit<z.infer<typeof sessionSettledParams>, "epoch">;
export type FinalReply = z.infer<typeof finalReply>;
export type ProvisionConfiguration = z.infer<typeof provisionConfiguration>;
