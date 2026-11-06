import { parse as parsePartialJson } from "partial-json";
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

abstract class MessageBase<T extends AgentMessage, Role extends string = T["role"]> {
  abstract readonly role: Role;

  constructor(
    readonly raw: T,
    readonly entryId: string | null,
    readonly parentEntryId: string | null,
    readonly renderKey: string,
  ) {}

  abstract toMarkdown(): string | null;
}

function userMessageMarkdown(message: AgentUserMessage): string | null {
  const text = typeof message.content === "string"
    ? message.content
    : textFromClientContent(message.content);
  return text.length > 0 ? text : null;
}

export class UserMessage extends MessageBase<AgentUserMessage> {
  readonly role = "user" as const;

  /** The backend extension it comes from (`reins.sessions`), or null for a message typed in the app. */
  get sourceExtension(): string | null {
    const value = this.raw.metadata?.sourceExtension;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  /** Its content without its details: what its bubble shows. */
  get visibleContent(): AgentUserMessage["content"] {
    const marked = this.markedDetails();
    return marked === null || typeof this.raw.content === "string" ? this.raw.content : this.raw.content.slice(0, marked.start);
  }

  /** More of it for the model (`metadata.details`: its content from `start`, set by the server), which the chat
   * shows collapsed under it; null when it has none. */
  get details(): { label: string | null; text: string } | null {
    const marked = this.markedDetails();
    if (marked === null || typeof this.raw.content === "string") return null;
    return { label: marked.label, text: textFromClientContent(this.raw.content.slice(marked.start)) };
  }

  private markedDetails(): { start: number; label: string | null } | null {
    const details: unknown = this.raw.metadata?.details;
    if (typeof details !== "object" || details === null || !("start" in details)) return null;
    const { start } = details;
    const label = "label" in details && typeof details.label === "string" && details.label.length > 0 ? details.label : null;
    const length = typeof this.raw.content === "string" ? 0 : this.raw.content.length;
    return typeof start === "number" && Number.isInteger(start) && start >= 1 && start < length ? { start, label } : null;
  }

  toMarkdown(): string | null {
    return userMessageMarkdown({ ...this.raw, content: this.visibleContent });
  }
}

export class SessionUpdateMessage extends MessageBase<AgentUserMessage, "sessionUpdate"> {
  readonly role = "sessionUpdate" as const;

  get sourceSessionId(): string {
    const value = this.raw.metadata?.sourceSessionId;
    if (typeof value !== "string") throw new Error("Session update is missing its source session");
    return value;
  }

  toMarkdown(): string | null {
    return userMessageMarkdown(this.raw);
  }
}

/** The live state of a tool call by its ID, if it has one. */
export type ToolExecutionLookup = (toolCallId: string) => ToolExecution | undefined;

const noExecutions: ToolExecutionLookup = () => undefined;
/** Shared, so a message given it again is unchanged. */
const RUNNING: ToolExecution = { status: "running" };

/** A tool call enriched with its saved result or its live execution. */
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

  private parsedPartialArguments: Record<string, any> | undefined;

  /** The arguments written so far, while the model is still writing them (`partialJson`, from
   * `toolcall_start` until `toolcall_end`); parsed once per block, which is made once per frame. */
  private get partialArguments(): Record<string, any> {
    this.parsedPartialArguments ??= parsePartialArguments(this.call.partialJson ?? "");
    return this.parsedPartialArguments;
  }

  /** A streaming call is running from its start, its arguments filling in; one with no name yet is not shown. */
  get renderData(): ToolBlockData | null {
    const base = { id: this.call.id, name: this.call.name, args: this.call.arguments };
    if (this.result) {
      return {
        ...base,
        status: "done",
        result: { content: this.result.content, details: this.result.details },
        isError: this.result.isError,
      };
    }
    if (this.execution) return { ...base, ...this.execution };
    if (this.streaming) {
      if (!this.call.name) return null;
      if (this.call.partialJson === undefined) return { ...base, status: "running" };
      return { ...base, args: this.partialArguments, status: "running", partialArgs: true };
    }
    return { ...base, status: "done" };
  }
}

function parsePartialArguments(json: string): Record<string, any> {
  if (!json.trim()) return {};
  try {
    const value: unknown = parsePartialJson(json);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    // Malformed until a later keyframe or toolcall_end replaces it.
    return {};
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
    executionOf: ToolExecutionLookup = noExecutions,
  ) {
    super(raw, entryId, parentEntryId, renderKey);
    this.blocks = raw.content.map((block) => block.type === "toolCall"
      ? new AssistantToolCallBlock(
        block,
        toolResults.get(block.id),
        executionOf(block.id),
        streaming,
      )
      : block);
  }

  /** This message with other live tool state, or itself when none of its tool calls would show differently. */
  withExecutions(executionOf: ToolExecutionLookup): AssistantMessage {
    const toolCalls = this.blocks.filter((block) => block instanceof AssistantToolCallBlock);
    if (toolCalls.every((block) => block.result || block.execution === executionOf(block.id))) return this;
    const results = new Map(toolCalls.flatMap((block) => block.result ? [[block.id, block.result] as const] : []));
    return new AssistantMessage(this.raw, this.entryId, this.parentEntryId, this.renderKey, this.streaming, results, executionOf);
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
  | SessionUpdateMessage
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
        return [typeof message.metadata?.sourceSessionId === "string" && message.metadata.sourceSessionId.length > 0
          ? new SessionUpdateMessage(message, entryId, parentEntryId, renderKey)
          : new UserMessage(message, entryId, parentEntryId, renderKey)];
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

/**
 * Apply live tool state to built messages, replacing only the assistants it
 * changes so the others keep their identity (and their rows skip rendering).
 * While the session runs, the latest assistant's calls with no result run too,
 * though no event may have said so since the page loaded; an older call with
 * none was cut off.
 */
export function applyToolExecutions(
  messages: Message[],
  executions: Readonly<Record<string, ToolExecution>>,
  running: boolean,
): Message[] {
  const latest = running ? messages.findLastIndex((message) => message.role === "assistant") : -1;
  let changed = false;
  const next = messages.map((message, index) => {
    if (!(message instanceof AssistantMessage)) return message;
    const updated = message.withExecutions((id) => executions[id] ?? (index === latest ? RUNNING : undefined));
    if (updated !== message) changed = true;
    return updated;
  });
  return changed ? next : messages;
}

/** Project authoritative runtime snapshots through the same assistant interface. */
export function buildStreamingMessages(
  assistants: readonly StreamingAssistant[],
  toolExecutions: Readonly<Record<string, ToolExecution>>,
): AssistantMessage[] {
  return assistants.map(({ streamId, message }) => new AssistantMessage(
    message,
    null,
    null,
    `streaming-assistant-${streamId}`,
    true,
    new Map(),
    (id) => toolExecutions[id],
  ));
}
