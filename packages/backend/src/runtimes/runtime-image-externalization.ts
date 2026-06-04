import type { PersistedContentBlock, RuntimeContentBlock, RuntimeMessage } from "../messages-store.js";
import { externalizeInlineImageBlock } from "../session-attachments-store.js";
import type {
  AgentRuntimeEvent,
  RuntimeToolResultPayload,
} from "./registry.js";

type ExternalizedRuntimeMessage = Omit<RuntimeMessage, "content"> & {
  content?: PersistedContentBlock[];
};

type ExternalizedRuntimeToolResultPayload = Omit<RuntimeToolResultPayload, "content"> & {
  content: PersistedContentBlock[];
};

type AgentEndEvent = Extract<AgentRuntimeEvent, { type: "agent_end" }>;
type TurnEndEvent = Extract<AgentRuntimeEvent, { type: "turn_end" }>;
type MessageEvent = Extract<AgentRuntimeEvent, { type: "message_start" | "message_update" | "message_end" }>;
type ToolExecutionEndEvent = Extract<AgentRuntimeEvent, { type: "tool_execution_end" }>;
type PassthroughEvent = Exclude<AgentRuntimeEvent, AgentEndEvent | TurnEndEvent | MessageEvent | ToolExecutionEndEvent>;

export type ExternalizedAgentRuntimeEvent =
  | PassthroughEvent
  | (Omit<AgentEndEvent, "messages"> & { messages: ExternalizedRuntimeMessage[] })
  | (Omit<TurnEndEvent, "message" | "toolResults"> & { message: ExternalizedRuntimeMessage; toolResults: ExternalizedRuntimeMessage[] })
  | (Omit<MessageEvent, "message"> & { message: ExternalizedRuntimeMessage })
  | (Omit<ToolExecutionEndEvent, "result"> & { result?: ExternalizedRuntimeToolResultPayload });

function externalizeContentBlockImages(sessionId: string, block: RuntimeContentBlock): PersistedContentBlock {
  if (block.type === "image") {
    return externalizeInlineImageBlock(sessionId, block);
  }
  return block;
}

function externalizeContentImages(sessionId: string, content: RuntimeContentBlock[]): PersistedContentBlock[] {
  return content.map((block) => externalizeContentBlockImages(sessionId, block));
}

function externalizeRuntimeMessageImages(
  sessionId: string,
  message: RuntimeMessage,
): ExternalizedRuntimeMessage {
  const { content, ...rest } = message;
  if (!content) return rest;
  return { ...rest, content: externalizeContentImages(sessionId, content) };
}

function externalizeToolResultImages(
  sessionId: string,
  result: RuntimeToolResultPayload | undefined,
): ExternalizedRuntimeToolResultPayload | undefined {
  if (!result) return result;
  return { ...result, content: externalizeContentImages(sessionId, result.content) };
}

export function externalizeRuntimeEventImages(
  sessionId: string,
  event: AgentRuntimeEvent,
): ExternalizedAgentRuntimeEvent {
  switch (event.type) {
    case "agent_end":
      return {
        ...event,
        messages: event.messages.map((message) => externalizeRuntimeMessageImages(sessionId, message)),
      };

    case "turn_end":
      return {
        ...event,
        message: externalizeRuntimeMessageImages(sessionId, event.message),
        toolResults: event.toolResults.map((message) => externalizeRuntimeMessageImages(sessionId, message)),
      };

    case "message_start":
    case "message_update":
    case "message_end":
      return {
        ...event,
        message: externalizeRuntimeMessageImages(sessionId, event.message),
      };

    case "tool_execution_end":
      return {
        ...event,
        result: externalizeToolResultImages(sessionId, event.result),
      };

    case "agent_start":
    case "turn_start":
    case "tool_execution_start":
    case "tool_execution_update":
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
      return event;
  }
}
