import type { ChatImageBlock } from "./chat-content.js";
import { textFromClientContent } from "./chat-content.js";

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
  arguments: Record<string, any>;
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

/** Return the raw Markdown represented by an actionable transcript message. */
export function messageMarkdown(message: AgentMessage): string | null {
  if (message.role === "user") {
    const text = typeof message.content === "string"
      ? message.content
      : textFromClientContent(message.content);
    return text.length > 0 ? text : null;
  }

  if (message.role === "assistant") {
    const text = message.content
      .flatMap((block) => block.type === "text" && block.text.length > 0 ? [block.text] : [])
      .join("\n\n");
    return text.length > 0 ? text : null;
  }

  return null;
}
