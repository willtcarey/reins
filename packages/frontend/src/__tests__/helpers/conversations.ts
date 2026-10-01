import type { AgentMessage } from "../../models/agent-message.js";
import type { ConversationEntry, ConversationsStore, MessageRecordPage } from "../../models/stores/conversations-store.js";

type PageInfo = MessageRecordPage["pageInfo"];
type ConversationPageFixture = Omit<ConversationEntry, "seq"> & { seq?: number };

export function conversationPage(
  itemFixtures: ConversationPageFixture[] = [],
  pageInfo: Partial<PageInfo> = {},
): MessageRecordPage {
  const items = itemFixtures.map((item, index) => ({ ...item, seq: item.seq ?? index + 1 }));
  return { items, pageInfo: {
    hasPreviousPage: false,
    previousCursor: null,
    hasNextPage: false,
    endCursor: items.at(-1)?.id ?? null,
    ...pageInfo,
  } };
}

export function messagePage(
  messages: AgentMessage[] = [],
  startId = 1,
  pageInfo: Partial<PageInfo> = {},
): MessageRecordPage {
  return conversationPage(messages.map((message, index) => {
    const id = startId + index;
    return { id: `entry-${id}`, parentId: id === 1 ? null : `entry-${id - 1}`, seq: id, message };
  }), pageInfo);
}

export function setPersistedMessages(store: ConversationsStore, sessionId: string, messages: AgentMessage[]) {
  store.mergeMessages(sessionId, messagePage(messages));
}

export interface ToolFixture { id: string; name?: string; arguments?: Record<string, unknown>; result?: string }

export function completedToolTurn(tools: ToolFixture[], finalText: string, startTimestamp = 100): AgentMessage[] {
  return [
    { role: "assistant", content: tools.map((tool) => ({ type: "toolCall" as const, id: tool.id, name: tool.name ?? "read", arguments: tool.arguments ?? { id: tool.id } })), timestamp: startTimestamp },
    ...tools.map((tool, index) => ({ role: "toolResult" as const, toolCallId: tool.id, toolName: tool.name ?? "read", content: [{ type: "text" as const, text: tool.result ?? tool.id }], isError: false, timestamp: startTimestamp + index + 1 })),
    { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop", timestamp: startTimestamp + tools.length + 1 },
  ];
}

export function applyStreamingTool(store: ConversationsStore, sessionId: string, tool: ToolFixture, done = false): void {
  const name = tool.name ?? "read";
  store.applyEvent(sessionId, { type: "tool_execution_start", toolCallId: tool.id, toolName: name, args: tool.arguments ?? { id: tool.id } });
  if (done) store.applyEvent(sessionId, { type: "tool_execution_end", toolCallId: tool.id, toolName: name, result: { content: [{ type: "text", text: tool.result ?? tool.id }] }, isError: false });
}

export type StreamingFixture = string | (ToolFixture & { done?: boolean });
export function applyStreamingAssistant(store: ConversationsStore, sessionId: string, blocks: StreamingFixture[], messageTimestamp = 100): void {
  store.applyEvent(sessionId, { type: "agent_start" });
  applyStreamingMessage(store, sessionId, messageTimestamp, blocks);
}

export function applyStreamingMessage(store: ConversationsStore, sessionId: string, messageTimestamp: number, blocks: StreamingFixture[]): void {
  let message: AgentMessage = { role: "assistant", content: [], timestamp: messageTimestamp };
  const streamId = `test-stream-${messageTimestamp}`;
  store.applyEvent(sessionId, { type: "message_start", streamId, message });
  for (const block of blocks) {
    message = { ...message, content: [...message.content, typeof block === "string" ? { type: "text" as const, text: block } : { type: "toolCall" as const, id: block.id, name: block.name ?? "read", arguments: block.arguments ?? { id: block.id } }] };
    store.applyEvent(sessionId, { type: "message_update", streamId, message, assistantMessageEvent: { type: typeof block === "string" ? "text_start" : "toolcall_start", contentIndex: message.content.length - 1 } });
    if (typeof block !== "string") applyStreamingTool(store, sessionId, block, block.done);
  }
  store.applyEvent(sessionId, { type: "message_end", streamId, message });
}

export function streamingContentKeys(store: ConversationsStore, sessionId: string): string[] {
  return store.get(sessionId).streamingMessages.flatMap((message) => message.blocks.flatMap((block) => block.type === "text" ? [`text:${block.text}`] : block.type === "toolCall" ? [`tool:${block.id}`] : []));
}
