/**
 * Chat State Reducer
 *
 * Pure conversation presentation state for chat panel events, extracted from
 * ChatPanel so it can be tested without Lit/DOM dependencies. Runtime activity
 * belongs exclusively to SessionCache and is not represented here.
 */

import type { ChatImageBlock } from "./chat-content.js";
import type { AgentMessage, AssistantMessage } from "./agent-message.js";

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
  /** Runtime-owned identity for one streaming assistant lifecycle. */
  streamId: string;
  /** Durable identity learned at message_end, before the canonical entry arrives. */
  durableId?: string;
  message: AssistantMessage;
  toolExecutions: Record<string, ToolExecution>;
}

/** Runtime message lifecycle events include user and tool-result messages in Pi. */
type RuntimeLifecycleMessage = AgentMessage;

/** Runtime, compaction, retry, and synthetic user events handled by the reducer. */
export type ChatEvent =
  | { type: "agent_start" }
  | { type: "message_start"; message: RuntimeLifecycleMessage; streamId: string }
  | { type: "message_update"; message: RuntimeLifecycleMessage; streamId: string; assistantMessageEvent?: { type: string; delta?: string } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult?: Record<string, unknown> }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: ToolExecution["result"]; isError?: boolean }
  | {
    type: "agent_end";
    messages?: AgentMessage[];
    runId?: string;
    status?: "completed" | "failed" | "aborted";
    error?: { code?: string; message: string; details?: unknown };
  }
  | { type: "message_end"; message: RuntimeLifecycleMessage; streamId: string; entryId?: string }
  | { type: "entry_added"; entry: import("@backend/messages-store.js").ConversationEntry<RuntimeLifecycleMessage> }
  | { type: "compaction_start"; reason?: string }
  | { type: "compaction_end"; result?: { summary?: string }; aborted?: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

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

/** Upsert one explicitly identified streaming overlay. */
function upsertAssistantSnapshot(
  state: ChatState,
  event: Extract<ChatEvent, { type: "message_start" | "message_update" | "message_end" }>,
): ChatState {
  const message = event.message;
  if (message.role !== "assistant") return state;
  const streamId = event.streamId;
  const index = state.streamingAssistants.findIndex((current) => current.streamId === streamId);
  if (index === -1) {
    return {
      ...state,
      streamingAssistants: [...state.streamingAssistants, {
        streamId,
        ...(event.type === "message_end" && event.entryId ? { durableId: event.entryId } : {}),
        message,
        toolExecutions: {},
      }],
    };
  }
  const streamingAssistants = [...state.streamingAssistants];
  const current = streamingAssistants[index]!;
  const toolCallIds = new Set(message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []));
  const toolExecutions = Object.fromEntries(
    Object.entries(current.toolExecutions).filter(([toolCallId]) => toolCallIds.has(toolCallId)),
  );
  streamingAssistants[index] = {
    ...current,
    ...(event.type === "message_end" && event.entryId ? { durableId: event.entryId } : {}),
    message,
    toolExecutions,
  };
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
  durableIds: ReadonlySet<string>,
): Pick<ChatState, "streamingAssistants"> {
  const streamingAssistants = state.streamingAssistants.filter(({ durableId }) => (
    !durableId || !durableIds.has(durableId)
  ));
  return streamingAssistants.length === state.streamingAssistants.length ? state : { ...state, streamingAssistants };
}

/** Apply one chat event without side effects, preserving state identity for no-ops. */
export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    // Runtime activity belongs to SessionCache. These lifecycle boundaries do
    // not alter conversation presentation; agent_end below is the separate
    // presentation-finalization boundary.
    case "agent_start":
      return state;

    case "message_start":
    case "message_update":
    case "message_end":
      return upsertAssistantSnapshot(state, event);

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
      let errorMessage = event.error?.message ?? state.errorMessage;
      const eventMessages = event.messages;
      if (!event.error && eventMessages) {
        // The last failed assistant carries the user-facing runtime error.
        for (let i = eventMessages.length - 1; i >= 0; i--) {
          const message = eventMessages[i];
          if (message.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
            errorMessage = message.errorMessage;
            break;
          }
        }
      }

      return {
        ...state,
        streamingAssistants: [],
        errorMessage,
      };
    }

    case "compaction_start":
      return { ...state, isCompacting: true };

    case "compaction_end":
      return state.isCompacting ? { ...state, isCompacting: false } : state;

    // Durable entry insertion is owned by ConversationsStore, where it can be
    // reconciled against pages and optimistic submissions by stable identity.
    case "entry_added":
      return state;

    case "auto_retry_start":
      return { ...state, errorMessage: `Retrying (${event.attempt}/${event.maxAttempts})… ${event.errorMessage}` };

    case "auto_retry_end":
      return event.success
        ? { ...state, errorMessage: "" }
        : { ...state, errorMessage: event.finalError || "All retry attempts failed" };

    default:
      return state;
  }
}
