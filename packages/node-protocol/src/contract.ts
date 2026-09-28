import { z } from "zod";

/** The server's durable session commands (its `node_command_outbox` rows) and their results. The node
 * serves each command through its own wire method (`schema.ts`); this vocabulary is the
 * outbox's, plus the shared session configuration, prompt content and node error codes. */
const sessionId = z.string().min(1);
/** Frozen at session creation: the model/thinking level Pi's lane starts with (null model: none
 * resolved; null thinking: off) and the task snapshot the system prompt and branch checkout use
 * (null: scratch session). Later product edits are not propagated. The wire `session.provision`
 * carries exactly this value, so a replay (which re-sends the stored command) carries the same bytes. */
export const sessionConfiguration = z.strictObject({
  model: z.strictObject({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).nullable(),
  thinkingLevel: z.string().min(1).max(32).nullable(),
  task: z.strictObject({ title: z.string(), description: z.string().nullable(), branchName: z.string().min(1).max(1024) }).nullable(),
});
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Image MIME types an attachment may have. */
export const imageMimeType = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const MAX_PROMPT_BLOCKS = 64;
export const MAX_PROMPT_TEXT = 4 * 1024 * 1024;
/** Inputs carry server-scoped attachment references, never inline image bytes (strict: a block with
 * `data` or any other extra field is rejected). */
const promptImage = z.strictObject({
  type: z.literal("image"), attachmentId: z.string().min(1).max(128),
  mimeType: imageMimeType,
  byteSize: z.number().min(0).max(MAX_ATTACHMENT_BYTES), sha256: z.string().max(128).optional(), filename: z.string().max(4096).optional(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
}).refine(value => (value.width === undefined) === (value.height === undefined), "Image dimensions must be paired");
/** Prompt/steer content: text and attachment references only (the node fetches the bytes). */
export const promptContent = z.array(z.union([
  z.strictObject({ type: z.literal("text"), text: z.string().max(MAX_PROMPT_TEXT) }), promptImage,
])).max(MAX_PROMPT_BLOCKS);
const sessionInput = { sessionId, clientId: sessionId, content: promptContent, sourceSessionId: z.string().min(1).max(128).nullable() };
export const nodeCommand = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("session.provision"), sessionId, sourceId: z.number().int().positive(), configuration: sessionConfiguration }),
  z.object({ op: z.literal("session.prompt"), ...sessionInput }),
  z.object({ op: z.literal("session.steer"), ...sessionInput }),
  z.object({ op: z.literal("session.abort"), sessionId }),
  z.object({ op: z.literal("session.resumePending"), sessionId }),
  /** Changes the model (and thinking level when given) Pi's lane uses from its next LLM turn. */
  z.object({ op: z.literal("session.setModel"), sessionId, provider: z.string().min(1), modelId: z.string().min(1), thinkingLevel: z.string().min(1).optional() }),
  /** Moves the session's canonical state onto the node of `targetSourceId`: the node pulls the server's
   * copy row for row, replacing any copy it already holds (see node-contract.md *Session relocation*). The
   * binding, task snapshot and snapshot summary are resolved when the command is delivered, not stored with it. */
  z.object({ op: z.literal("session.hydrate"), sessionId, targetSourceId: z.number().int().positive() }),
]);
/** `not_owner`: the server refused a node→server write because the sending node no longer owns the
 * session (it was moved elsewhere); definite, never retried. */
export const nodeErrorCode = z.enum(["unavailable", "invalid_request", "busy", "not_found", "not_owner", "internal"]);
export const nodeResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("provisioned") }),
    z.object({ kind: z.literal("admitted"), inputId: z.string().min(1) }),
    z.object({ kind: z.literal("aborted"), aborted: z.boolean() }),
    z.object({ kind: z.literal("resumed"), started: z.boolean() }),
    z.object({ kind: z.literal("modelSet") }),
    z.object({ kind: z.literal("hydrated") }),
  ]) }),
  z.object({ ok: z.literal(false), error: z.object({ code: nodeErrorCode, message: z.string(), retryable: z.boolean() }) }),
]);
export type NodeCommand = z.infer<typeof nodeCommand>;
export type SessionConfiguration = z.infer<typeof sessionConfiguration>;

/** Delivery semantics: submitted work goes through the server outbox (requeued when its delivery outcome
 * is unknown); request-now controls are sent immediately and fail to their caller. */
export function deliveryPolicy(command: NodeCommand): "submit-work" | "request-now" {
  return command.op === "session.abort" || command.op === "session.resumePending" ? "request-now" : "submit-work";
}
export type NodeResult = z.infer<typeof nodeResult>;
