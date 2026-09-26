import { z } from "zod";

/** Semantic vocabulary only. No transport framing, correlation or replay guarantee yet. */
export const contractVersion = 3 as const;
const sessionId = z.string().min(1);
/** Inputs carry server-scoped attachment references, never inline image bytes. */
const image = z.object({
  type: z.literal("image"),
  attachmentId: z.string(),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  byteSize: z.number().finite().nonnegative(),
  filename: z.string().optional(),
  sha256: z.string().optional(),
  width: z.number().finite().positive().optional(),
  height: z.number().finite().positive().optional(),
}).refine(value => (value.width === undefined) === (value.height === undefined), "Image dimensions must be paired");
const input = z.array(z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  image,
]));
export const nodeCommand = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("session.provision"), sessionId, sourceId: z.number().int().positive() }),
  z.object({ op: z.literal("session.prompt"), sessionId, clientId: sessionId, content: input, sourceSessionId: z.string().nullable().optional() }),
  z.object({ op: z.literal("session.steer"), sessionId, clientId: sessionId, content: input, sourceSessionId: z.string().nullable().optional() }),
  z.object({ op: z.literal("session.abort"), sessionId }),
  z.object({ op: z.literal("session.resumePending"), sessionId }),
]);
export const nodeErrorCode = z.enum(["unavailable", "unsupported", "invalid_request", "busy", "not_found", "internal"]);
export const nodeResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("provisioned") }),
    z.object({ kind: z.literal("admitted"), inputId: z.string().min(1) }),
    z.object({ kind: z.literal("aborted"), aborted: z.boolean() }),
    z.object({ kind: z.literal("resumed"), started: z.boolean() }),
  ]) }),
  z.object({ ok: z.literal(false), error: z.object({ code: nodeErrorCode, message: z.string(), retryable: z.boolean() }) }),
]);
/** An observation, not a second canonical transcript writer. */
export const nodeEvent = z.object({ sessionId, kind: z.enum(["runtime", "lifecycle", "canonical_entry"]), payload: z.unknown() });
export type NodeCommand = z.infer<typeof nodeCommand>;

/** Delivery semantics for future transport; current internal adapter executes immediately. */
export function deliveryPolicy(command: NodeCommand): "submit-work" | "request-now" {
  return command.op === "session.abort" || command.op === "session.resumePending" ? "request-now" : "submit-work";
}
export type NodeResult = z.infer<typeof nodeResult>;
export type NodeEvent = z.infer<typeof nodeEvent>;
