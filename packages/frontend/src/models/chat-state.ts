/**
 * Chat State Reducer
 *
 * Pure conversation presentation state for chat panel events, extracted from
 * ChatPanel so it can be tested without Lit/DOM dependencies. Runtime activity
 * belongs exclusively to SessionCache and is not represented here.
 */

import type { ChatImageBlock } from "./chat-content.js";
import type { AgentMessage, AssistantMessage, ToolCall } from "./agent-message.js";

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
 * One live assistant message: the last full snapshot with the deltas since
 * applied. Tool overlays stay with their owner and are keyed by stable call ID
 * so concurrent assistants cannot mix.
 */
export interface StreamingAssistant {
  /** Runtime-owned identity for one streaming assistant lifecycle. */
  streamId: string;
  /** Durable identity learned at message_end, before the canonical entry arrives. */
  durableId?: string;
  message: AssistantMessage;
  toolExecutions: Record<string, ToolExecution>;
  /** Deltas may have been missed: the content is kept, but further deltas are
   * ignored until the next full snapshot (keyframe or message_end). */
  stale?: true;
}

/**
 * One step of a streaming assistant message (Pi's assistant stream event
 * without its snapshot). `contentIndex` addresses `message.content`: a block
 * appears with the keyframe that accompanies its `*_start`, grows by each
 * `*_delta` (a tool call's raw argument JSON as `partialJson`) and is
 * authoritative at its `*_end`.
 */
export type AssistantStreamEvent =
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall };

/** Runtime message lifecycle events include user and tool-result messages in Pi. */
type RuntimeLifecycleMessage = AgentMessage;

/** Runtime, compaction, retry, and synthetic user events handled by the reducer. */
export type ChatEvent =
  | { type: "agent_start" }
  | { type: "message_start"; message: RuntimeLifecycleMessage; streamId: string }
  /** `message`, when present, is a keyframe: the full message after this step. */
  | { type: "message_update"; message?: RuntimeLifecycleMessage; streamId: string; assistantMessageEvent: AssistantStreamEvent }
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
  streamingAssistants: StreamingAssistant[];
  isCompacting: boolean;
  errorMessage: string;
}

export function initialChatState(): ChatState {
  return {
    streamingAssistants: [],
    isCompacting: false,
    errorMessage: "",
  };
}

/** Replace one explicitly identified streaming overlay with a full snapshot. */
function upsertAssistantSnapshot(
  state: ChatState,
  streamId: string,
  message: AgentMessage,
  entryId: string | undefined,
): ChatState {
  if (message.role !== "assistant") return state;
  const index = state.streamingAssistants.findIndex((current) => current.streamId === streamId);
  if (index === -1) {
    return {
      ...state,
      streamingAssistants: [...state.streamingAssistants, {
        streamId,
        ...(entryId ? { durableId: entryId } : {}),
        message,
        toolExecutions: {},
      }],
    };
  }
  const streamingAssistants = [...state.streamingAssistants];
  const { stale: _stale, ...current } = streamingAssistants[index]!;
  const toolCallIds = new Set(message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []));
  const toolExecutions = Object.fromEntries(
    Object.entries(current.toolExecutions).filter(([toolCallId]) => toolCallIds.has(toolCallId)),
  );
  streamingAssistants[index] = {
    ...current,
    ...(entryId ? { durableId: entryId } : {}),
    message,
    toolExecutions,
  };
  return { ...state, streamingAssistants };
}

type AssistantBlock = AssistantMessage["content"][number];

/** The block after one step, or undefined when the step does not fit it. */
function applyStreamStep(block: AssistantBlock | undefined, step: AssistantStreamEvent): AssistantBlock | undefined {
  switch (step.type) {
    case "text_delta": return block?.type === "text" ? { ...block, text: block.text + step.delta } : undefined;
    case "text_end": return block?.type === "text" ? { ...block, text: step.content } : undefined;
    case "thinking_delta": return block?.type === "thinking" ? { ...block, thinking: block.thinking + step.delta } : undefined;
    case "thinking_end": return block?.type === "thinking" ? { ...block, thinking: step.content } : undefined;
    case "toolcall_delta": return block?.type === "toolCall" ? { ...block, partialJson: (block.partialJson ?? "") + step.delta } : undefined;
    case "toolcall_end": return block?.type === "toolCall" && block.id === step.toolCall.id ? step.toolCall : undefined;
    // A block's start always arrives with a keyframe that already holds it.
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return undefined;
  }
}

/**
 * Apply a step without a snapshot to its stream's overlay. An unknown stream
 * or stale overlay waits for the next keyframe; a step that does not fit the
 * content marks the overlay stale rather than guessing.
 */
function applyAssistantDelta(state: ChatState, streamId: string, step: AssistantStreamEvent): ChatState {
  const index = state.streamingAssistants.findIndex((current) => current.streamId === streamId);
  const current = state.streamingAssistants[index];
  if (!current || current.stale) return state;
  const block = applyStreamStep(current.message.content[step.contentIndex], step);
  const streamingAssistants = [...state.streamingAssistants];
  if (!block) {
    streamingAssistants[index] = { ...current, stale: true };
    return { ...state, streamingAssistants };
  }
  const content = [...current.message.content];
  content[step.contentIndex] = block;
  streamingAssistants[index] = { ...current, message: { ...current.message, content } };
  return { ...state, streamingAssistants };
}

/**
 * Mark every streaming overlay stale after events may have been lost (a
 * sequence gap, including across a reconnect). Preserves identity when there
 * is nothing to mark.
 */
export function markStreamsStale<T extends Pick<ChatState, "streamingAssistants">>(state: T): T {
  if (state.streamingAssistants.every(({ stale }) => stale)) return state;
  return { ...state, streamingAssistants: state.streamingAssistants.map((assistant) => assistant.stale ? assistant : { ...assistant, stale: true as const }) };
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
    case "message_end":
      return upsertAssistantSnapshot(state, event.streamId, event.message, event.type === "message_end" ? event.entryId : undefined);

    case "message_update":
      return event.message
        ? upsertAssistantSnapshot(state, event.streamId, event.message, undefined)
        : applyAssistantDelta(state, event.streamId, event.assistantMessageEvent);

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
      // agent_end clears all streaming assistants for the completed run and
      // surfaces its terminal error; transcript entries arrive only as entry_added.
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
