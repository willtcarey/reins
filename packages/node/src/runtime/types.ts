import type { LocalPromptBlock } from "../resources/prompt.js";

export type ClientPromptContent = LocalPromptBlock[];
export type RuntimeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "image"; data: string; mimeType: string; filename?: string; width?: number; height?: number };
export interface RuntimeMessage {
  role: string;
  metadata?: Record<string, unknown>;
  content?: RuntimeContentBlock[];
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
  timestamp?: number;
}
export interface RuntimePromptSubmission { messageId: string }
export interface SetRuntimeModelParams { provider: string; modelId: string; thinkingLevel?: string | null }
export type AgentRuntimeEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: RuntimeMessage[]; runId?: string; status?: "completed" | "failed" | "aborted"; error?: RuntimeOperationError }
  | { type: "turn_start" }
  | { type: "turn_end"; message: RuntimeMessage; toolResults: RuntimeMessage[] }
  | { type: "message_start"; message: RuntimeMessage; streamId: string }
  | { type: "message_update"; message: RuntimeMessage; streamId: string; assistantMessageEvent: { type: string; delta?: string; [key: string]: unknown } }
  | { type: "message_end"; message: RuntimeMessage; streamId: string; entryId?: string }
  | { type: "entry_added"; entry: ConversationEntry<RuntimeMessage> }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: { content: RuntimeContentBlock[]; details?: Record<string, unknown>; [key: string]: unknown }; isError: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; result?: { summary?: string }; aborted?: boolean; errorMessage?: string; willRetry?: boolean };

// Type-only import keeps the lifecycle interface tied to the native node runtime.
import type { AgentHarnessPiRuntime } from "./pi-runtime.js";
