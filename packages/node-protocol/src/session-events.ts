/** The runtime event and message shapes that cross the link in `session.event` and that both sides read
 * (the node projects Pi's messages into them; the server relays them to browsers and reads replies), and
 * the helpers that find and replace their image blocks. */
import type { z } from "zod";
import type { imageReference, textBlock } from "./fields.js";

/** A server-stored attachment: user prompt images always, and node images once `attachment.store` accepted them. */
export type ImageReferenceBlock = z.infer<typeof imageReference>;
/** Prompt content as a session holds it: text and server-stored attachment references. */
export type PromptBlock = z.infer<typeof textBlock> | ImageReferenceBlock;
/** Base64 image bytes as Pi holds them (e.g. a tool result reading a PNG). Never sent in a session event. */
export type InlineImageBlock = { type: "image"; data: string; mimeType: string; filename?: string; width?: number; height?: number };
type RuntimeImageBlock = InlineImageBlock | ImageReferenceBlock;
/** `TImage` narrows image blocks: a runtime holds both kinds, a `session.event` only references. */
export type RuntimeContentBlock<TImage extends RuntimeImageBlock = RuntimeImageBlock> =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | TImage;
export interface RuntimeMessage<TImage extends RuntimeImageBlock = RuntimeImageBlock> {
  role: string;
  metadata?: Record<string, unknown>;
  content?: RuntimeContentBlock<TImage>[];
  stopReason?: string;
  summary?: string;
  [key: string]: unknown;
}
export interface ConversationEntry<TMessage = RuntimeMessage> {
  id: string;
  parentId: string | null;
  seq: number;
  clientId?: string;
  message: TMessage;
}
/** One step of a streaming assistant message: Pi's `assistantMessageEvent` without its `partial` snapshot.
 * `contentIndex` addresses the message's `content`. A block starts as the keyframe that accompanies its
 * `*_start` shows it, grows by each `*_delta` (text, thinking, or a tool call's raw argument JSON) and is
 * authoritative at its `*_end`: `text_end`/`thinking_end` carry the block's final text, `toolcall_end` the
 * complete tool call with parsed arguments. */
export type AssistantStreamEvent =
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; [key: string]: unknown } };
export interface RuntimeOperationError { code?: string; message: string; details?: unknown }
export type AgentRuntimeEvent<TImage extends RuntimeImageBlock = RuntimeImageBlock> =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: RuntimeMessage<TImage>[]; runId?: string; status?: "completed" | "failed" | "aborted"; error?: RuntimeOperationError }
  | { type: "turn_start" }
  | { type: "turn_end"; message: RuntimeMessage<TImage>; toolResults: RuntimeMessage<TImage>[] }
  | { type: "message_start"; message: RuntimeMessage<TImage>; streamId: string }
  /** `message` is the full snapshot, sent only as a keyframe (see node-runtime.md *Events*). */
  | { type: "message_update"; message?: RuntimeMessage<TImage>; streamId: string; assistantMessageEvent: AssistantStreamEvent }
  | { type: "message_end"; message: RuntimeMessage<TImage>; streamId: string; entryId?: string }
  | { type: "entry_added"; entry: ConversationEntry<RuntimeMessage<TImage>> }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: { content: RuntimeContentBlock<TImage>[]; details?: Record<string, unknown>; [key: string]: unknown }; isError: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; result?: { summary?: string }; aborted?: boolean; errorMessage?: string; willRetry?: boolean };

/** The final assistant reply of a transcript as `session.settled` reports it (`reply`). */
export interface FinalReply { text: string | null; stopReason: string | null; errorMessage: string | null }

/** The last assistant message's text, stop reason and error, or null when there is none. The node reports
 * it for child sessions at settlement; the server reads it from its storage for `sessions.wait`. */
export function finalReply(messages: readonly RuntimeMessage[]): FinalReply | null {
  const last = messages.findLast(message => message.role === "assistant");
  if (!last) return null;
  return {
    text: Array.isArray(last.content) ? last.content.filter(block => block.type === "text").map(block => String(block.text)).join("\n") : null,
    stopReason: last.stopReason ?? null,
    errorMessage: last.errorMessage == null ? null : String(last.errorMessage),
  };
}

/** Image blocks live in `content` arrays (messages, tool results, partial tool results). These helpers
 * visit exactly those blocks anywhere in a value, so the node can turn tool-result images into attachment
 * references and replace any image that is not one before it sends a session event. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isImage = (value: unknown): value is Record<string, unknown> & { type: "image" } => isRecord(value) && value.type === "image";

/** Every image block found in a `content` array anywhere inside `value`. */
export function contentImages(value: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown, inContent: boolean) => {
    if (Array.isArray(node)) { for (const item of node) { if (inContent && isImage(item)) found.push(item); else visit(item, false); } return; }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) visit(child, key === "content" && Array.isArray(child));
  };
  visit(value, false);
  return found;
}

/** Copy of `value` with every image block in a `content` array replaced by `replace(block)`; other
 * values are shared, not cloned. */
export function mapContentImages(value: unknown, replace: (block: Record<string, unknown>) => unknown): unknown {
  const visit = (node: unknown, inContent: boolean): unknown => {
    if (Array.isArray(node)) return node.map(item => inContent && isImage(item) ? replace(item) : visit(item, false));
    if (!isRecord(node)) return node;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child, key === "content" && Array.isArray(child))]));
  };
  return visit(value, false);
}
