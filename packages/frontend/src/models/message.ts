import { textFromClientContent } from "./chat-content.js";
import type { StreamingAssistant, ToolBlockData, ToolExecution } from "./chat-state.js";
import type {
  AgentMessage,
  AssistantMessage as AgentAssistantMessage,
  CompactionSummaryMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage as AgentUserMessage,
} from "./agent-message.js";

/** Stable transcript identity carried by every displayable message. */
export interface MessageIdentity {
  entryId: string | null;
  parentEntryId: string | null;
  renderKey: string;
}

/** Raw store entry shape accepted by the display-message projection. */
export interface MessageSource extends MessageIdentity {
  message: AgentMessage;
}

abstract class MessageBase<T extends AgentMessage> {
  abstract readonly role: T["role"];

  constructor(
    readonly raw: T,
    readonly entryId: string | null,
    readonly parentEntryId: string | null,
    readonly renderKey: string,
  ) {}

  abstract toMarkdown(): string | null;
}

export class UserMessage extends MessageBase<AgentUserMessage> {
  readonly role = "user" as const;

  toMarkdown(): string | null {
    const text = typeof this.raw.content === "string"
      ? this.raw.content
      : textFromClientContent(this.raw.content);
    return text.length > 0 ? text : null;
  }
}

/** A tool call enriched with the result or live execution owned by its assistant. */
export class AssistantToolCallBlock {
  readonly type = "toolCall" as const;

  constructor(
    readonly call: ToolCall,
    readonly result: ToolResultMessage | undefined,
    readonly execution: ToolExecution | undefined,
    private readonly streaming: boolean,
  ) {}

  get id(): string { return this.call.id; }
  get name(): string { return this.call.name; }
  get arguments(): Record<string, any> { return this.call.arguments; }

  /** Rendering data is unavailable for partial streaming calls until execution starts. */
  get renderData(): ToolBlockData | null {
    if (this.streaming) return this.execution ?? null;

    return {
      id: this.call.id,
      name: this.call.name,
      args: this.call.arguments,
      status: "done",
      ...(this.result ? {
        result: { content: this.result.content, details: this.result.details },
        isError: this.result.isError,
      } : {}),
    };
  }
}

export type AssistantConversationBlock = TextContent | ThinkingContent | AssistantToolCallBlock;

export class AssistantMessage extends MessageBase<AgentAssistantMessage> {
  readonly role = "assistant" as const;
  readonly blocks: AssistantConversationBlock[];

  constructor(
    raw: AgentAssistantMessage,
    entryId: string | null,
    parentEntryId: string | null,
    renderKey: string,
    readonly streaming: boolean,
    toolResults: ReadonlyMap<string, ToolResultMessage> = new Map(),
    toolExecutions: Readonly<Record<string, ToolExecution>> = {},
  ) {
    super(raw, entryId, parentEntryId, renderKey);
    this.blocks = raw.content.map((block) => block.type === "toolCall"
      ? new AssistantToolCallBlock(
        block,
        toolResults.get(block.id),
        toolExecutions[block.id],
        streaming,
      )
      : block);
  }

  toMarkdown(): string | null {
    const text = this.raw.content
      .flatMap((block) => block.type === "text" && block.text.length > 0 ? [block.text] : [])
      .join("\n\n");
    return text.length > 0 ? text : null;
  }

  get hasVisibleContent(): boolean {
    return this.blocks.some((block) => (
      (block.type === "text" && block.text.length > 0)
      || (block.type === "toolCall" && block.renderData !== null)
    ));
  }
}

export class CompactionMessage extends MessageBase<CompactionSummaryMessage> {
  readonly role = "compactionSummary" as const;
  toMarkdown(): null {
    return null;
  }
}

export type Message =
  | UserMessage
  | AssistantMessage
  | CompactionMessage;

/**
 * Project raw persisted/live entries into displayable domain messages. Tool
 * results are associated once by call ID instead of rendered as standalone rows.
 */
export function buildMessages(
  sources: readonly MessageSource[],
): Message[] {
  const toolResults = new Map<string, ToolResultMessage>();
  for (const { message } of sources) {
    if (message.role === "toolResult") toolResults.set(message.toolCallId, message);
  }

  return sources.flatMap((source): Message[] => {
    const { message, entryId, parentEntryId, renderKey } = source;
    switch (message.role) {
      case "user":
        return [new UserMessage(message, entryId, parentEntryId, renderKey)];
      case "assistant":
        return [new AssistantMessage(
          message,
          entryId,
          parentEntryId,
          renderKey,
          false,
          toolResults,
        )];
      case "compactionSummary":
        return [new CompactionMessage(message, entryId, parentEntryId, renderKey)];
      case "toolResult":
        return [];
    }
  });
}

/** Project authoritative runtime snapshots through the same assistant interface. */
export function buildStreamingMessages(
  assistants: readonly StreamingAssistant[],
): AssistantMessage[] {
  return assistants.map(({ message, toolExecutions }) => new AssistantMessage(
    message,
    null,
    null,
    `streaming-assistant-${message.timestamp}`,
    true,
    new Map(),
    toolExecutions,
  ));
}
