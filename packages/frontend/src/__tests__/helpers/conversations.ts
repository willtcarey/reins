import type { AgentMessage } from "../../models/chat-state.js";
import type {
  ConversationsStore, MessageRecordPage, PersistedConversationEntry,
} from "../../models/stores/conversations-store.js";

type PageInfo = MessageRecordPage["pageInfo"];

export function conversationPage(
  items: PersistedConversationEntry[] = [],
  pageInfo: Partial<PageInfo> = {},
): MessageRecordPage {
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
    return { id: String(id), parentId: id === 1 ? null : String(id - 1), message };
  }), pageInfo);
}

export function setPersistedMessages(store: ConversationsStore, sessionId: string, messages: AgentMessage[]) {
  store.mergeMessages(sessionId, messagePage(messages));
}
