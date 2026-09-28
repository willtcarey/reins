import type { LocalPromptBlock } from "../resources/prompt.js";

export type ClientPromptContent = LocalPromptBlock[];
/** Base64 image bytes as Pi holds them (e.g. a tool result reading a PNG). Never sent in a session event. */
export type InlineImageBlock = { type: "image"; data: string; mimeType: string; filename?: string; width?: number; height?: number };
/** A server-stored attachment: user prompt images always, and node images once `attachment.store` accepted them. */
export type ImageReferenceBlock = Extract<LocalPromptBlock, { type: "image" }>;
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
export interface RuntimeRunOutcome {
  runId: string;
  status: "completed" | "failed" | "aborted";
  error?: RuntimeOperationError;
}
export interface RuntimeLifecycleSink {
  started(runId: string): void;
  settled(runtime: AgentHarnessPiRuntime, outcome: RuntimeRunOutcome): void;
}
export interface RuntimePromptOptions {
  reinsId?: string;
  metadata?: Record<string, unknown>;
}
export interface RuntimePromptSubmission { messageId: string }
/** The model a session selects is not in the node's model registry. */
export class NodeModelNotFoundError extends Error {
  constructor(readonly provider: string, readonly modelId: string) {
    super(`Model not found: ${provider}/${modelId}`);
  }
}
export interface SetRuntimeModelParams { provider: string; modelId: string; thinkingLevel?: string | null }
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

// Type-only import keeps the lifecycle interface tied to the native node runtime.
import type { AgentHarnessPiRuntime } from "./pi-runtime.js";
