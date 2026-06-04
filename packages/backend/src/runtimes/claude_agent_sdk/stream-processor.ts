import type {
  SDKMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeMessage } from "../../messages-store.js";
import type { AgentRuntimeEvent } from "../registry.js";
import {
  normalizeClaudeToolName,
  toTextContent,
  mapStopReason,
  nowTs,
} from "./events.js";
import { normalizeToolArgs } from "./mappings.js";
import { isRecord } from "./type-guards.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SdkStreamEvent = SDKPartialAssistantMessage["event"];
type ContentBlockStartEvent = Extract<SdkStreamEvent, { type: "content_block_start" }>;
type ContentBlockDeltaEvent = Extract<SdkStreamEvent, { type: "content_block_delta" }>;
type ContentBlockStopEvent = Extract<SdkStreamEvent, { type: "content_block_stop" }>;
type MessageDeltaEvent = Extract<SdkStreamEvent, { type: "message_delta" }>;

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface TrackedToolCall {
  toolName: string;
  args: Record<string, unknown>;
  partialJson?: string;
  block?: ToolCallBlock;
}

interface CurrentStreamBlock {
  kind: "text" | "thinking" | "toolCall";
  block:
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | ToolCallBlock;
  toolCallId?: string;
}

interface StreamProcessorState {
  activeAssistant: RuntimeMessage | null;
  currentToolCalls: Map<string, TrackedToolCall>;
  turnToolResults: RuntimeMessage[];
  emittedToolExecutionEnd: Set<string>;
  emittedMessageStart: boolean;
  emittedTurnStart: boolean;
  currentStreamBlocks?: Map<number, CurrentStreamBlock>;
  /** Messages accumulated from completed intermediate turns within one agent loop. */
  completedTurnMessages: RuntimeMessage[];
}

interface UserToolResult {
  toolCallId: string;
  content: unknown;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Exported class
// ---------------------------------------------------------------------------

/**
 * Encapsulates the stateful stream-processing logic for mapping Claude SDK
 * messages into Reins AgentRuntimeEvents.
 */
export class ClaudeStreamProcessor {
  private readonly state: StreamProcessorState = {
    activeAssistant: null,
    currentToolCalls: new Map(),
    turnToolResults: [],
    emittedToolExecutionEnd: new Set(),
    emittedMessageStart: false,
    emittedTurnStart: false,
    completedTurnMessages: [],
  };

  /** Summary text captured from the PostCompact hook callback. */
  private pendingCompactSummary: string | null = null;

  /** Map a single SDK message into zero or more runtime events. */
  process(message: SDKMessage): AgentRuntimeEvent[] {
    return this.mapSdkMessage(message);
  }

  /**
   * Mark the turn as already started so that later SDK events don't emit
   * a duplicate `agent_start`.  Used by the runtime to signal streaming
   * start ahead of the first SDK content event.
   */
  markStreamingStarted(): void {
    this.state.emittedTurnStart = true;
  }

  /**
   * Store the compaction summary received from the PostCompact hook.
   * Called by the runtime when the SDK fires the PostCompact hook callback,
   * before the compact_boundary message arrives in the stream.
   *
   * The raw hook output may contain an `<analysis>...</analysis>` section
   * (Claude's internal reasoning) followed by a `<summary>...</summary>`
   * section. We strip the analysis and extract just the summary content.
   */
  setCompactSummary(raw: string): void {
    this.pendingCompactSummary = extractSummaryContent(raw);
  }

  // ---------------------------------------------------------------------------
  // Private — top-level SDK message dispatch
  // ---------------------------------------------------------------------------

  private mapSdkMessage(message: SDKMessage): AgentRuntimeEvent[] {
    switch (message.type) {
      case "system":
        if (message.subtype === "compact_boundary") {
          return this.handleCompactBoundary();
        }
        return [];

      case "tool_progress":
        return this.handleToolProgress(message);

      case "tool_use_summary":
        return this.handleToolUseSummary(message);

      case "user":
        return this.handleUserMessage(message);

      case "stream_event":
        return this.handleStreamEvent(message);

      case "assistant":
        return [];

      case "result":
        return this.handleResult(message);

      default:
        return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private — stream event handlers
  // ---------------------------------------------------------------------------

  private handleStreamEvent(event: SDKMessage & { type: "stream_event" }): AgentRuntimeEvent[] {
    const streamEvent = event.event;

    switch (streamEvent.type) {
      case "message_start":
        return this.closeIntermediateTurnBoundary();

      case "content_block_start":
        return this.handleContentBlockStart(streamEvent);

      case "content_block_delta":
        return this.handleContentBlockDelta(streamEvent);

      case "content_block_stop":
        return this.handleContentBlockStop(streamEvent);

      case "message_delta":
        return this.handleMessageDelta(streamEvent);

      case "message_stop":
        return [];
    }
  }

  private handleContentBlockStart(event: ContentBlockStartEvent): AgentRuntimeEvent[] {
    const startEvents = this.ensureTurnAndMessageStart();
    const assistant = this.ensureAssistant();
    const currentBlocks = this.ensureCurrentStreamBlocks();
    const index = event.index;
    const contentBlock = event.content_block;

    if (contentBlock.type === "text") {
      const block = { type: "text" as const, text: "" };
      this.contentOf(assistant).push(block);
      currentBlocks.set(index, { kind: "text", block });
      return startEvents;
    }

    if (contentBlock.type === "thinking") {
      const block = { type: "thinking" as const, thinking: "" };
      this.contentOf(assistant).push(block);
      currentBlocks.set(index, { kind: "thinking", block });
      return startEvents;
    }

    if (contentBlock.type === "tool_use") {
      const toolCallId = String(contentBlock.id ?? "");
      const toolName = normalizeClaudeToolName(contentBlock.name);
      const block: ToolCallBlock = {
        type: "toolCall",
        id: toolCallId,
        name: toolName,
        arguments: {},
      };

      this.contentOf(assistant).push(block);
      currentBlocks.set(index, { kind: "toolCall", block, toolCallId });
      this.state.currentToolCalls.set(toolCallId, {
        toolName,
        args: {},
        partialJson: "",
        block,
      });

      return startEvents;
    }

    return startEvents;
  }

  private handleContentBlockDelta(event: ContentBlockDeltaEvent): AgentRuntimeEvent[] {
    const startEvents = this.ensureTurnAndMessageStart();
    const currentBlocks = this.ensureCurrentStreamBlocks();
    const streamBlock = currentBlocks.get(event.index);
    const delta = event.delta;

    if (delta.type === "text_delta") {
      const assistant = this.ensureAssistant();
      let block = streamBlock?.kind === "text" ? streamBlock.block : null;
      if (!block || block.type !== "text") {
        block = { type: "text" as const, text: "" };
        this.contentOf(assistant).push(block);
        currentBlocks.set(event.index, { kind: "text", block });
      }
      block.text += delta.text ?? "";

      return [
        ...startEvents,
        {
          type: "message_update",
          message: assistant,
          assistantMessageEvent: {
            type: "text_delta",
            delta: delta.text ?? "",
          },
        },
      ];
    }

    if (delta.type === "thinking_delta") {
      const assistant = this.ensureAssistant();
      let block = streamBlock?.kind === "thinking" ? streamBlock.block : null;
      if (!block || block.type !== "thinking") {
        block = { type: "thinking" as const, thinking: "" };
        this.contentOf(assistant).push(block);
        currentBlocks.set(event.index, { kind: "thinking", block });
      }
      block.thinking += delta.thinking ?? "";
      return startEvents;
    }

    if (delta.type === "input_json_delta") {
      if (!streamBlock || streamBlock.kind !== "toolCall" || !streamBlock.toolCallId) {
        return startEvents;
      }

      const tracked = this.state.currentToolCalls.get(streamBlock.toolCallId);
      if (!tracked) return startEvents;
      tracked.partialJson = `${tracked.partialJson ?? ""}${delta.partial_json ?? ""}`;
      return startEvents;
    }

    return startEvents;
  }

  private handleContentBlockStop(event: ContentBlockStopEvent): AgentRuntimeEvent[] {
    const currentBlocks = this.ensureCurrentStreamBlocks();
    const streamBlock = currentBlocks.get(event.index);
    if (!streamBlock || streamBlock.kind !== "toolCall" || !streamBlock.toolCallId) return [];

    const toolCallId = streamBlock.toolCallId;
    const tracked = this.state.currentToolCalls.get(toolCallId);
    if (!tracked) return [];

    const args = normalizeToolArgs(
      tracked.toolName,
      this.parseJson(tracked.partialJson ?? "", tracked.args),
    );

    tracked.args = args;
    delete tracked.partialJson;
    tracked.block = {
      type: "toolCall",
      id: toolCallId,
      name: tracked.toolName,
      arguments: args,
    };
    if (streamBlock.block.type === "toolCall") {
      streamBlock.block.name = tracked.toolName;
      streamBlock.block.arguments = args;
    }

    return [{
      type: "tool_execution_start",
      toolCallId,
      toolName: tracked.toolName,
      args,
    }];
  }

  private handleMessageDelta(event: MessageDeltaEvent): AgentRuntimeEvent[] {
    const assistant = this.ensureAssistant();
    assistant.stopReason = mapStopReason(event.delta.stop_reason);
    return [];
  }

  // ---------------------------------------------------------------------------
  // Private — top-level SDK message handlers
  // ---------------------------------------------------------------------------

  private handleCompactBoundary(): AgentRuntimeEvent[] {
    const summary = this.pendingCompactSummary ?? "";
    this.pendingCompactSummary = null;
    return [
      { type: "compaction_start", reason: "claude_sdk_compact_boundary" },
      { type: "compaction_end", result: { summary }, aborted: false },
    ];
  }

  private handleToolProgress(message: SDKToolProgressMessage): AgentRuntimeEvent[] {
    const toolName = normalizeClaudeToolName(message.tool_name);
    return [{
      type: "tool_execution_update",
      toolCallId: message.tool_use_id,
      toolName,
      args: this.state.currentToolCalls.get(message.tool_use_id)?.args ?? {},
      partialResult: { elapsedTimeSeconds: message.elapsed_time_seconds },
    }];
  }

  private handleToolUseSummary(message: SDKToolUseSummaryMessage): AgentRuntimeEvent[] {
    const events: AgentRuntimeEvent[] = [];

    for (const id of message.preceding_tool_use_ids) {
      const toolCallId = String(id ?? "");
      if (!toolCallId) continue;

      const tracked = this.state.currentToolCalls.get(toolCallId);
      const endEvent = this.registerToolExecutionEnd({
        toolCallId,
        toolName: tracked?.toolName ?? "tool",
      });
      if (endEvent) events.push(endEvent);
    }

    return events;
  }

  private handleUserMessage(message: { message: { role: string; content: unknown }; parent_tool_use_id: string | null; tool_use_result?: unknown }): AgentRuntimeEvent[] {
    const toolResults: UserToolResult[] = [];

    if (message.parent_tool_use_id && message.tool_use_result) {
      toolResults.push({
        toolCallId: String(message.parent_tool_use_id),
        content: message.tool_use_result,
        isError: false,
      });
    }

    const blocks = message.message?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (!isRecord(block)) continue;
        if (block.type !== "tool_result") continue;

        toolResults.push({
          toolCallId: String(block.tool_use_id ?? ""),
          content: block.content,
          isError: Boolean(block.is_error),
        });
      }
    }

    const events: AgentRuntimeEvent[] = [];

    for (const toolResult of toolResults) {
      if (!toolResult.toolCallId) continue;
      const tracked = this.state.currentToolCalls.get(toolResult.toolCallId);
      const toolName = tracked?.toolName ?? "tool";
      const content = toTextContent(toolResult.content);

      const exists = this.state.turnToolResults.some((entry) => entry.role === "toolResult" && entry.toolCallId === toolResult.toolCallId);
      if (!exists) {
        this.state.turnToolResults.push({
          role: "toolResult",
          toolCallId: toolResult.toolCallId,
          toolName,
          content,
          isError: toolResult.isError,
          timestamp: nowTs(),
        });
      }

      const endEvent = this.registerToolExecutionEnd({
        toolCallId: toolResult.toolCallId,
        toolName,
        result: { content },
        isError: toolResult.isError,
      });
      if (endEvent) events.push(endEvent);
    }

    return events;
  }

  private handleResult(message: SDKResultMessage): AgentRuntimeEvent[] {
    const stopReason = mapStopReason(message.stop_reason);
    if (!this.state.emittedTurnStart) return [];
    return this.completeTurn(stopReason);
  }

  // ---------------------------------------------------------------------------
  // Private — state management
  // ---------------------------------------------------------------------------

  private ensureAssistant(): RuntimeMessage {
    if (this.state.activeAssistant) return this.state.activeAssistant;
    const assistant: RuntimeMessage = {
      role: "assistant",
      content: [],
      timestamp: nowTs(),
    };
    this.state.activeAssistant = assistant;
    return assistant;
  }

  private contentOf(msg: RuntimeMessage): unknown[] {
    if (!Array.isArray(msg.content)) msg.content = [];
    return msg.content;
  }

  private ensureCurrentStreamBlocks(): Map<number, CurrentStreamBlock> {
    if (!this.state.currentStreamBlocks) {
      this.state.currentStreamBlocks = new Map();
    }
    return this.state.currentStreamBlocks;
  }

  private resetCurrentStreamBlocks(): void {
    this.state.currentStreamBlocks?.clear();
  }

  // ---------------------------------------------------------------------------
  // Private — tool execution events
  // ---------------------------------------------------------------------------

  private buildToolExecutionEndEvent(params: {
    toolCallId: string;
    toolName: string;
    result?: { content: { type: "text"; text: string }[] };
    isError?: boolean;
  }): AgentRuntimeEvent {
    return {
      type: "tool_execution_end",
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      ...(params.result ? { result: params.result } : {}),
      isError: params.isError ?? false,
    };
  }

  private registerToolExecutionEnd(params: {
    toolCallId: string;
    toolName: string;
    result?: { content: { type: "text"; text: string }[] };
    isError?: boolean;
  }): AgentRuntimeEvent | null {
    if (!params.toolCallId || this.state.emittedToolExecutionEnd.has(params.toolCallId)) {
      return null;
    }

    this.state.emittedToolExecutionEnd.add(params.toolCallId);
    return this.buildToolExecutionEndEvent(params);
  }

  // ---------------------------------------------------------------------------
  // Private — turn lifecycle
  // ---------------------------------------------------------------------------

  private ensureTurnAndMessageStart(): AgentRuntimeEvent[] {
    const events: AgentRuntimeEvent[] = [];

    if (!this.state.emittedTurnStart) {
      this.state.emittedTurnStart = true;
      events.push({ type: "agent_start" });
      events.push({ type: "turn_start" });
    }

    if (!this.state.emittedMessageStart) {
      this.state.emittedMessageStart = true;
      const assistant = this.ensureAssistant();
      events.push({ type: "message_start", message: assistant });
    }

    return events;
  }

  /**
   * Close the current internal turn at an SDK turn boundary (between
   * tool_result and the next message_start).  Emits turn_end so the
   * persistence observer snapshots messages mid-loop, without ending
   * the outer agent lifecycle.
   */
  private closeIntermediateTurnBoundary(): AgentRuntimeEvent[] {
    this.resetCurrentStreamBlocks();

    if (!this.state.activeAssistant) return [];

    const events: AgentRuntimeEvent[] = [];
    const assistant = this.state.activeAssistant;

    events.push({ type: "message_end", message: assistant });
    events.push({
      type: "turn_end",
      message: assistant,
      toolResults: this.state.turnToolResults,
    });

    // Accumulate this turn's messages so agent_end includes the full loop
    this.state.completedTurnMessages.push(assistant, ...this.state.turnToolResults);

    // Reset turn-local state for the next internal turn
    this.state.activeAssistant = null;
    this.state.currentToolCalls.clear();
    this.state.turnToolResults = [];
    this.state.emittedToolExecutionEnd.clear();
    this.state.emittedMessageStart = false;
    // Keep emittedTurnStart = true — the outer agent is still running

    // Signal that a new internal turn is starting
    events.push({ type: "turn_start" });

    return events;
  }

  private endIntermediateTurn(): AgentRuntimeEvent[] {
    if (!this.state.emittedTurnStart) return [];

    const events: AgentRuntimeEvent[] = [];
    const assistant = this.ensureAssistant();

    events.push({ type: "message_end", message: assistant });
    events.push({
      type: "turn_end",
      message: assistant,
      toolResults: this.state.turnToolResults,
    });

    this.state.activeAssistant = null;
    this.state.currentToolCalls.clear();
    this.state.turnToolResults = [];
    this.state.emittedToolExecutionEnd.clear();
    this.state.emittedMessageStart = false;
    this.state.emittedTurnStart = false;
    this.resetCurrentStreamBlocks();

    return events;
  }

  private completeTurn(stopReason?: string): AgentRuntimeEvent[] {
    if (!this.state.emittedTurnStart) return [];

    const assistant = this.ensureAssistant();
    if (stopReason) assistant.stopReason = stopReason;
    const turnToolResults = this.state.turnToolResults;
    const previousTurnMessages = this.state.completedTurnMessages;

    const events = this.endIntermediateTurn();

    // Include messages from all turns in the loop (intermediate + final)
    events.push({
      type: "agent_end",
      messages: [...previousTurnMessages, assistant, ...turnToolResults],
    });

    this.state.completedTurnMessages = [];

    return events;
  }

  // ---------------------------------------------------------------------------
  // Private — utilities
  // ---------------------------------------------------------------------------

  private parseJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
    try {
      return JSON.parse(input);
    } catch {
      return fallback;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Extract the useful summary from the raw PostCompact hook output.
 *
 * The hook output may contain `<analysis>...</analysis>` (Claude's internal
 * reasoning about how to summarise) followed by `<summary>...</summary>`
 * (the actual summary). We want only the summary content. If the tags are
 * absent, return the raw string as-is.
 */
export function extractSummaryContent(raw: string): string {
  const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) return summaryMatch[1].trim();

  // No <summary> tag — strip <analysis> block if present and return the rest
  const analysisEnd = raw.indexOf("</analysis>");
  if (analysisEnd >= 0) return raw.slice(analysisEnd + "</analysis>".length).trim();

  return raw;
}
