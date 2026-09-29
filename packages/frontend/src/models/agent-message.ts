import type { ChatImageBlock } from "./chat-content.js";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  /** Parsed arguments; while a call streams, as of its last snapshot. */
  arguments: Record<string, any>;
  /** While a call streams: its raw argument JSON so far. */
  partialJson?: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  timestamp: number;
  /** Present when the LLM call ended abnormally (for example, "error" or "aborted"). */
  stopReason?: string;
  /** Human-readable error detail when stopReason is "error". */
  errorMessage?: string;
}

type UserMessageContent = string | (TextContent | ChatImageBlock)[];

export interface UserMessage {
  role: "user";
  content: UserMessageContent;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ChatImageBlock)[];
  details?: Record<string, any>;
  isError: boolean;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  content?: string;
  summary?: string;
  timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CompactionSummaryMessage;
