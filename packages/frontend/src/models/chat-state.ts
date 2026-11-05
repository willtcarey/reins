/**
 * Chat State Reducer
 *
 * Pure conversation presentation state for chat panel events, extracted from
 * ChatPanel so it can be tested without Lit/DOM dependencies. Runtime activity
 * belongs exclusively to SessionCache and is not represented here.
 */

import { isImageAttachmentBlock, isInlineImageBlock, type ChatImageBlock } from "./chat-content.js";
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

/**
 * What the runtime has said about one tool call while it runs: applied over
 * the call with its ID, whether that call is still streaming or already saved
 * (Pi saves an assistant before its tools run). `result` is the latest
 * partial result until the call ends, then its final one.
 */
export interface ToolExecution {
  status: "running" | "done";
  result?: ToolBlockData["result"];
  isError?: boolean;
}

/** Partial text kept per tool call: as much as bash keeps of its output (its tail). */
export const MAX_PARTIAL_TOOL_TEXT = 50 * 1024;

/** One live assistant message: the last full snapshot with the deltas since applied. */
export interface StreamingAssistant {
  /** Runtime-owned identity for one streaming assistant lifecycle. */
  streamId: string;
  /** Durable identity learned at message_end, before the canonical entry arrives. */
  durableId?: string;
  message: AssistantMessage;
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
  | { type: "compaction_end"; result?: { summary?: string }; aborted?: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

export interface ChatState {
  streamingAssistants: StreamingAssistant[];
  /** Live tool state by tool call ID, until the call's result is saved or its run ends. */
  toolExecutions: Readonly<Record<string, ToolExecution>>;
  isCompacting: boolean;
  errorMessage: string;
}

export function initialChatState(): ChatState {
  return {
    streamingAssistants: [],
    toolExecutions: {},
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
      }],
    };
  }
  const streamingAssistants = [...state.streamingAssistants];
  const { stale: _stale, ...current } = streamingAssistants[index]!;
  streamingAssistants[index] = {
    ...current,
    ...(entryId ? { durableId: entryId } : {}),
    message,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A partial result as the chat shows it: text and image blocks, the text cut to its tail. */
function partialToolResult(partial: Record<string, unknown> | undefined): ToolBlockData["result"] | undefined {
  if (!partial || !Array.isArray(partial.content)) return undefined;
  const content: NonNullable<ToolBlockData["result"]>["content"] = [];
  let budget = MAX_PARTIAL_TOOL_TEXT;
  // From the end, so a long output keeps what was written last.
  for (let index = partial.content.length - 1; index >= 0; index--) {
    const block: unknown = partial.content[index];
    if (typeof block !== "object" || block === null || !("type" in block)) continue;
    if (block.type === "text" && "text" in block && typeof block.text === "string") {
      if (budget === 0) continue;
      const text = block.text.length > budget ? block.text.slice(block.text.length - budget) : block.text;
      budget -= text.length;
      content.unshift({ type: "text", text });
    } else if (isInlineImageBlock(block) || isImageAttachmentBlock(block)) {
      content.unshift(block);
    }
  }
  const { details } = partial;
  return { content, ...(isRecord(details) ? { details } : {}) };
}

function setToolExecution(state: ChatState, toolCallId: string, execution: ToolExecution): ChatState {
  return { ...state, toolExecutions: { ...state.toolExecutions, [toolCallId]: execution } };
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

    // Keyed by call ID alone: the call may be streaming, saved, or not shown
    // yet; whichever has this ID shows it.
    case "tool_execution_start":
      return state.toolExecutions[event.toolCallId] ? state : setToolExecution(state, event.toolCallId, { status: "running" });

    case "tool_execution_update": {
      if (state.toolExecutions[event.toolCallId]?.status === "done") return state;
      const result = partialToolResult(event.partialResult);
      return setToolExecution(state, event.toolCallId, { status: "running", ...(result ? { result } : {}) });
    }

    case "tool_execution_end":
      return setToolExecution(state, event.toolCallId, {
        status: "done",
        ...(event.result ? { result: event.result } : {}),
        ...(event.isError !== undefined ? { isError: event.isError } : {}),
      });

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
        toolExecutions: {},
        errorMessage,
      };
    }

    case "compaction_start":
      return { ...state, isCompacting: true };

    case "compaction_end":
      if (event.errorMessage) return { ...state, isCompacting: false, errorMessage: event.errorMessage };
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
