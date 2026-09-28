/** The runtime event and message shapes that cross the link in `session.event` and that both sides read
 * (the node projects Pi's messages into them; the server relays them to browsers and reads replies). */

/** Prompt content as a session holds it: text and server-stored attachment references. */
export type PromptBlock = { type: "text"; text: string } | {
  type: "image"; attachmentId: string; mimeType: string;
  filename?: string; byteSize: number; sha256?: string; width?: number; height?: number;
};
/** Base64 image bytes as Pi holds them (e.g. a tool result reading a PNG). Never sent in a session event. */
export type InlineImageBlock = { type: "image"; data: string; mimeType: string; filename?: string; width?: number; height?: number };
/** A server-stored attachment: user prompt images always, and node images once `attachment.store` accepted them. */
export type ImageReferenceBlock = Extract<PromptBlock, { type: "image" }>;
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
export interface RuntimeOperationError { code?: string; message: string; details?: unknown }
export type AgentRuntimeEvent<TImage extends RuntimeImageBlock = RuntimeImageBlock> =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: RuntimeMessage<TImage>[]; runId?: string; status?: "completed" | "failed" | "aborted"; error?: RuntimeOperationError }
  | { type: "turn_start" }
  | { type: "turn_end"; message: RuntimeMessage<TImage>; toolResults: RuntimeMessage<TImage>[] }
  | { type: "message_start"; message: RuntimeMessage<TImage>; streamId: string }
  | { type: "message_update"; message: RuntimeMessage<TImage>; streamId: string; assistantMessageEvent: { type: string; delta?: string; [key: string]: unknown } }
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
 * it for child sessions at settlement; the server reads it from its replica when it has no report. */
export function finalReply(messages: readonly RuntimeMessage[]): FinalReply | null {
  const last = messages.findLast(message => message.role === "assistant");
  if (!last) return null;
  return {
    text: Array.isArray(last.content) ? last.content.filter(block => block.type === "text").map(block => String(block.text)).join("\n") : null,
    stopReason: last.stopReason ?? null,
    errorMessage: last.errorMessage == null ? null : String(last.errorMessage),
  };
}
