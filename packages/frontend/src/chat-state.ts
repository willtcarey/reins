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
  isError: boolean;
  timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

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
  result?: { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] };
  isError?: boolean;
}

export type StreamingBlock = StreamingTextBlock | StreamingToolBlock;

/** Normalized shape for rendering a tool call in both streaming and finalized states. */
export type ToolBlockData = StreamingToolBlock;

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
export function applyChatEvent(state: ChatState, event: any): ChatState {
  switch (event.type) {
    case "agent_start":
      return { ...state, isStreaming: true, streamingBlocks: [] };

    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (ame?.type === "text_delta") {
        const blocks = [...state.streamingBlocks];
        const last = blocks[blocks.length - 1];
        if (last && last.type === "text") {
          blocks[blocks.length - 1] = { ...last, text: last.text + ame.delta };
        } else {
          blocks.push({ type: "text", text: ame.delta });
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
      let messages = state.messages;
      if (event.messages) {
        const existing = new Set(
          state.messages.map((m: AgentMessage) => `${m.role}:${m.timestamp}`)
        );
        const fresh = (event.messages as AgentMessage[]).filter(
          (m) => m.role !== "user" && !existing.has(`${m.role}:${m.timestamp}`)
        );
        if (fresh.length > 0) {
          messages = [...state.messages, ...fresh];
        }
      }
      return {
        ...state,
        isStreaming: false,
        streamingBlocks: [],
        messages,
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
            role: "compactionSummary" as any,
            content: event.result?.summary || "Conversation summarized",
            timestamp: Date.now(),
          },
        ],
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
