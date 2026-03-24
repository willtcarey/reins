/**
 * Chat State Reducer
 *
 * Pure state management for chat panel events, extracted from ChatPanel
 * so it can be tested without Lit/DOM dependencies.
 */

// ---- Types (matching pi-ai / pi-agent-core shapes) -------------------------

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
  /** Present when the LLM call ended abnormally (e.g. "error", "aborted"). */
  stopReason?: string;
  /** Human-readable error detail when stopReason is "error". */
  errorMessage?: string;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | { type: "image"; data: string; mimeType: string })[];
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | { type: "image"; data: string; mimeType: string })[];
  details?: Record<string, any>;
  isError: boolean;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  content: string;
  summary?: string;
  timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CompactionSummaryMessage;

export interface StreamingTextBlock {
  type: "text";
  text: string;
}

export interface StreamingToolBlock {
  type: "tool";
  id: string;
  name: string;
  args: Record<string, any>;
  status: "running" | "done";
  result?: { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; details?: Record<string, any> };
  isError?: boolean;
}

export type StreamingBlock = StreamingTextBlock | StreamingToolBlock;

/** Normalized shape for rendering a tool call in both streaming and finalized states. */
export type ToolBlockData = Omit<StreamingToolBlock, "type">;

// ---- Events (local mirrors of backend/SDK shapes) --------------------------

/**
 * Discriminated union of every event type that `applyChatEvent` handles.
 * Covers AgentEvent variants we care about, CompactionEvent, and the
 * synthetic `user_message` forwarded by ws-client.
 */
export type ChatEvent =
  | { type: "agent_start" }
  | { type: "message_update"; assistantMessageEvent?: { type: string; delta?: string } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: StreamingToolBlock["result"]; isError?: boolean }
  | { type: "agent_end"; messages?: AgentMessage[] }
  | { type: "message_end" }
  | { type: "compaction_start"; reason?: string }
  | { type: "compaction_end"; result?: { summary?: string }; aborted?: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "user_message"; message: string };

// ---- State ------------------------------------------------------------------

export interface ChatState {
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingBlocks: StreamingBlock[];
  isCompacting: boolean;
  shouldAutoScroll: boolean;
  errorMessage: string;
}

export function initialChatState(): ChatState {
  return {
    messages: [],
    isStreaming: false,
    streamingBlocks: [],
    isCompacting: false,
    shouldAutoScroll: true,
    errorMessage: "",
  };
}

// ---- Reducer ----------------------------------------------------------------

/**
 * Apply an agent event to the chat state, returning a new state.
 * Pure function — no side effects.
 */
export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "agent_start":
      return { ...state, isStreaming: true, streamingBlocks: [] };

    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (ame?.type === "text_delta" && ame.delta) {
        const delta = ame.delta;
        const blocks = [...state.streamingBlocks];
        const last = blocks[blocks.length - 1];
        if (last && last.type === "text") {
          blocks[blocks.length - 1] = { ...last, text: last.text + delta };
        } else {
          blocks.push({ type: "text", text: delta });
        }
        return { ...state, streamingBlocks: blocks };
      }
      return state;
    }

    case "tool_execution_start":
      return {
        ...state,
        streamingBlocks: [
          ...state.streamingBlocks,
          {
            type: "tool",
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
            status: "running" as const,
          },
        ],
      };

    case "tool_execution_end": {
      const blocks = state.streamingBlocks.map((b) =>
        b.type === "tool" && b.id === event.toolCallId
          ? { ...b, status: "done" as const, result: event.result, isError: event.isError }
          : b
      );
      return { ...state, streamingBlocks: blocks };
    }

    case "agent_end": {
      // event.messages contains only the messages produced during this
      // agent run (user prompts + assistant replies + tool results).
      // Normally we append the non-user messages (user messages were
      // added optimistically in handleSend). However, if sessionData
      // was refreshed mid-run (reconnect, navigation), state.messages
      // already contains some/all of these. Deduplicate by skipping
      // messages whose role+timestamp already exist.

      // Check for error: the last assistant message may have stopReason: "error"
      // with an empty content array, indicating the LLM call failed entirely.
      let errorMessage = state.errorMessage;
      const eventMessages: AgentMessage[] | undefined = event.messages;
      if (eventMessages) {
        for (let i = eventMessages.length - 1; i >= 0; i--) {
          const m = eventMessages[i];
          if (m.role === "assistant" && m.stopReason === "error" && m.errorMessage) {
            errorMessage = m.errorMessage;
            break;
          }
        }
      }

      let messages = state.messages;
      if (eventMessages) {
        const existing = new Set(
          state.messages.map((m: AgentMessage) => `${m.role}:${m.timestamp}`)
        );
        // Filter out empty error assistant messages — they shouldn't appear in the UI
        const fresh = eventMessages.filter((m) => {
          if (m.role === "user") return false;
          if (existing.has(`${m.role}:${m.timestamp}`)) return false;
          // Skip empty assistant messages with stopReason: "error"
          if (m.role === "assistant" && m.stopReason === "error" && m.content.length === 0) {
            return false;
          }
          return true;
        });
        if (fresh.length > 0) {
          messages = [...state.messages, ...fresh];
        }
      }
      return {
        ...state,
        isStreaming: false,
        streamingBlocks: [],
        messages,
        errorMessage,
      };
    }

    case "message_end":
      return state;

    case "compaction_start":
      return { ...state, isCompacting: true };

    case "compaction_end":
      if (event.aborted) {
        return { ...state, isCompacting: false };
      }
      return {
        ...state,
        isCompacting: false,
        messages: [
          ...state.messages,
          {
            role: "compactionSummary",
            content: event.result?.summary || "Conversation summarized",
            timestamp: Date.now(),
          },
        ],
      };

    case "auto_retry_start":
      return {
        ...state,
        errorMessage: `Retrying (${event.attempt}/${event.maxAttempts})… ${event.errorMessage}`,
      };

    case "auto_retry_end":
      if (event.success) {
        return { ...state, errorMessage: "" };
      }
      return {
        ...state,
        errorMessage: event.finalError || "All retry attempts failed",
      };

    case "user_message":
      return {
        ...state,
        shouldAutoScroll: true,
        messages: [
          ...state.messages,
          {
            role: "user" as const,
            content: event.message,
            timestamp: Date.now(),
          },
        ],
      };

    default:
      return state;
  }
}
