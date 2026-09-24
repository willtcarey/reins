import { z } from "zod";

/** Semantic vocabulary only. No transport framing, correlation or replay guarantee yet. */
export const contractVersion = 1 as const;
const sessionId = z.string().min(1);
const input = z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
]));
export const nodeCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("session.open"), sessionId, sourceId: z.number().int().positive(), mode: z.enum(["create", "reopen"]) }),
  z.object({ op: z.literal("session.prompt"), sessionId, clientId: sessionId, content: input }),
  z.object({ op: z.literal("session.steer"), sessionId, clientId: sessionId, content: input }),
  z.object({ op: z.literal("session.abort"), sessionId }),
  z.object({ op: z.literal("session.resumePending"), sessionId }),
]);
export const nodeResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("opened"), pendingOperation: z.boolean() }),
    z.object({ kind: z.literal("admitted"), inputId: z.string().min(1) }),
    z.object({ kind: z.literal("aborted"), aborted: z.boolean() }),
    z.object({ kind: z.literal("resumed"), started: z.boolean() }),
  ]) }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.enum(["unavailable", "unsupported", "invalid_request", "busy", "not_found", "internal"]), message: z.string(), retryable: z.boolean() }) }),
]);
/** An observation, not a second canonical transcript writer. */
export const nodeEvent = z.object({ sessionId, kind: z.enum(["runtime", "lifecycle", "canonical_entry"]), payload: z.unknown() });
export type NodeCommand = z.infer<typeof nodeCommand>;
export type NodeResult = z.infer<typeof nodeResult>;
export type NodeEvent = z.infer<typeof nodeEvent>;
