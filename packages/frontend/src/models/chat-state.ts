/**
 * Chat State Reducer
 *
 * Pure conversation presentation state for chat panel events, extracted from
 * ChatPanel so it can be tested without Lit/DOM dependencies. Runtime activity
 * belongs exclusively to SessionCache and is not represented here.
 */

import type { ChatImageBlock, ClientPromptContent } from "./chat-content.js";

interface TextContent {
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

/** Normalized rendering data shared by live and finalized tool calls. */
export interface ToolBlockData {
  id: string;
  name: string;
  args: Record<string, any>;
  status: "running" | "done";
  result?: { content: ({ type: "text"; text: string } | ChatImageBlock)[]; details?: Record<string, any> };
  isError?: boolean;
  sessionId?: string;
}

export interface ToolExecution extends ToolBlockData {}

/**
 * One authoritative live assistant snapshot. Tool overlays stay with their
 * owner and are keyed by stable call ID so concurrent assistants cannot mix.
 */
export interface StreamingAssistant {
  message: AssistantMessage;
  toolExecutions: Record<string, ToolExecution>;
}

/** Runtime message lifecycle events include user and tool-result messages in Pi. */
type RuntimeLifecycleMessage = AgentMessage;

/** Runtime, compaction, retry, and synthetic user events handled by the reducer. */
export type ChatEvent =
  | { type: "agent_start" }
  | { type: "agent_settled" }
  | { type: "message_start"; message: RuntimeLifecycleMessage }
  | { type: "message_update"; message: RuntimeLifecycleMessage; assistantMessageEvent?: { type: string; delta?: string } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult?: Record<string, unknown> }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: ToolExecution["result"]; isError?: boolean }
  | { type: "agent_end"; messages?: AgentMessage[] }
  | { type: "message_end"; message: RuntimeLifecycleMessage }
  | { type: "compaction_start"; reason?: string }
  | { type: "compaction_end"; result?: { summary?: string }; aborted?: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "user_message"; message: ClientPromptContent };

export interface ChatState {
  messages: AgentMessage[];
  streamingAssistants: StreamingAssistant[];
  isCompacting: boolean;
  errorMessage: string;
}

export function initialChatState(): ChatState {
  return {
    messages: [],
    streamingAssistants: [],
    isCompacting: false,
    errorMessage: "",
  };
}

/**
 * Upsert a runtime's authoritative assistant snapshot by timestamp. Timestamps
 * identify a lifecycle, not display order, so updates replace the observed slot
 * rather than sorting on runtime clocks.
 */
function upsertAssistantSnapshot(state: ChatState, message: RuntimeLifecycleMessage): ChatState {
  if (message.role !== "assistant") return state;
  const index = state.streamingAssistants.findIndex(({ message: current }) => current.timestamp === message.timestamp);
  if (index === -1) {
    return { ...state, streamingAssistants: [...state.streamingAssistants, { message, toolExecutions: {} }] };
  }
  if (state.streamingAssistants[index]?.message === message) return state;
  const streamingAssistants = [...state.streamingAssistants];
  const current = streamingAssistants[index]!;
  const toolCallIds = new Set(message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []));
  // A replacement snapshot is authoritative: overlays for tool calls it no
  // longer contains must not leak into this assistant's rendered content.
  const toolExecutions = Object.fromEntries(
    Object.entries(current.toolExecutions).filter(([toolCallId]) => toolCallIds.has(toolCallId)),
  );
  streamingAssistants[index] = { message, toolExecutions };
  return { ...state, streamingAssistants };
}

/** Find the assistant that owns a tool call by the runtime's stable call ID. */
function assistantIndexForToolCall(state: ChatState, toolCallId: string): number {
  return state.streamingAssistants.findIndex(({ message }) => (
    message.content.some((block) => block.type === "toolCall" && block.id === toolCallId)
  ));
}

/** Update a tool overlay within its owning assistant snapshot. */
function updateToolExecution(
  state: ChatState,
  toolCallId: string,
  build: (existing: ToolExecution | undefined) => ToolExecution,
): ChatState {
  const index = assistantIndexForToolCall(state, toolCallId);
  // Without an owning snapshot, placement is unknowable; a later complete
  // assistant update can recover the tool call without inventing ordering.
  if (index === -1) return state;
  const streamingAssistants = [...state.streamingAssistants];
  const assistant = streamingAssistants[index]!;
  streamingAssistants[index] = {
    ...assistant,
    toolExecutions: { ...assistant.toolExecutions, [toolCallId]: build(assistant.toolExecutions[toolCallId]) },
  };
  return { ...state, streamingAssistants };
}

/**
 * Remove live assistants now represented by persisted snapshots. Unmatched
 * assistants (including newer work) survive until their own persistence catch-up.
 */
export function removePersistedStreamingAssistants(
  state: Pick<ChatState, "streamingAssistants">,
  timestamps: ReadonlySet<number>,
): Pick<ChatState, "streamingAssistants"> {
  const streamingAssistants = state.streamingAssistants.filter(({ message }) => !timestamps.has(message.timestamp));
  return streamingAssistants.length === state.streamingAssistants.length ? state : { ...state, streamingAssistants };
}

/** Apply one chat event without side effects, preserving state identity for no-ops. */
export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    // Runtime activity belongs to SessionCache. These lifecycle boundaries do
    // not alter conversation presentation; agent_end below is the separate
    // presentation-finalization boundary.
    case "agent_start":
    case "agent_settled":
      return state;

    case "message_start":
    case "message_update":
    case "message_end":
      return upsertAssistantSnapshot(state, event.message);

    case "tool_execution_start":
      return updateToolExecution(state, event.toolCallId, (existing) => ({
        ...existing,
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: existing?.status ?? "running",
      }));

    case "tool_execution_update":
      return updateToolExecution(state, event.toolCallId, (existing) => ({
        id: event.toolCallId,
        name: event.toolName || existing?.name || "tool",
        args: { ...existing?.args, ...event.args },
        status: existing?.status ?? "running",
        ...(existing?.result ? { result: existing.result } : {}),
        ...(existing?.isError !== undefined ? { isError: existing.isError } : {}),
      }));

    case "tool_execution_end":
      return updateToolExecution(state, event.toolCallId, (existing) => ({
        id: event.toolCallId,
        name: event.toolName || existing?.name || "tool",
        args: existing?.args ?? {},
        status: "done",
        ...(event.result ? { result: event.result } : {}),
        ...(event.isError !== undefined ? { isError: event.isError } : {}),
      }));

    case "agent_end": {
      // agent_end promotes canonical final messages into presentation state,
      // then clears all streaming assistants for the completed run.
      let errorMessage = state.errorMessage;
      const eventMessages = event.messages;
      if (eventMessages) {
        // The last failed assistant carries the user-facing runtime error.
        for (let i = eventMessages.length - 1; i >= 0; i--) {
          const message = eventMessages[i];
          if (message.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
            errorMessage = message.errorMessage;
            break;
          }
        }
      }

      let messages = state.messages;
      if (eventMessages) {
        const existing = new Set(state.messages.map((message) => (
          message.role === "toolResult"
            ? `toolResult:${message.toolCallId}`
            : `${message.role}:${message.timestamp}`
        )));
        const fresh: AgentMessage[] = [];
        for (const message of eventMessages) {
          // Runtime user messages may contain transformed prompt content; the
          // browser's optimistic/user_message entry remains the display copy.
          if (message.role === "user") continue;
          if (message.role === "assistant" && message.stopReason === "error" && message.content.length === 0) {
            continue;
          }
          const key = message.role === "toolResult"
            ? `toolResult:${message.toolCallId}`
            : `${message.role}:${message.timestamp}`;
          if (existing.has(key)) continue;
          existing.add(key);
          fresh.push(message);
        }
        if (fresh.length > 0) messages = [...state.messages, ...fresh];
      }
      return {
        ...state,
        messages,
        streamingAssistants: [],
        errorMessage,
      };
    }

    case "compaction_start":
      return { ...state, isCompacting: true };

    case "compaction_end":
      if (event.aborted) return { ...state, isCompacting: false };
      return {
        ...state,
        isCompacting: false,
        messages: [...state.messages, {
          role: "compactionSummary",
          content: event.result?.summary || "Conversation summarized",
          timestamp: Date.now(),
        }],
      };

    case "auto_retry_start":
      return { ...state, errorMessage: `Retrying (${event.attempt}/${event.maxAttempts})… ${event.errorMessage}` };

    case "auto_retry_end":
      return event.success
        ? { ...state, errorMessage: "" }
        : { ...state, errorMessage: event.finalError || "All retry attempts failed" };

    case "user_message":
      return {
        ...state,
        messages: [...state.messages, { role: "user", content: event.message, timestamp: Date.now() }],
      };

    default:
      return state;
  }
}
