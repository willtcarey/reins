/**
 * Conversations Store
 *
 * Per-session conversation state. This keeps message/stream reconciliation out
 * of rendering components and lets WebSocket events update sessions even when
 * they are not the active route.
 */

import {
  applyChatEvent,
  initialChatState,
  type AgentMessage,
  type ChatState,
  userMessageContentKey,
} from "../chat-state.js";
import type { ClientPromptContent } from "../chat-content.js";
import type { FrontendEvent } from "../ws-client.js";
import type { SessionCache } from "./session-cache.js";

export interface PersistedConversationEntry {
  id: string;
  parentId: string | null;
  message: AgentMessage;
}

export interface LiveConversationEntry {
  id: null;
  parentId: null;
  localId: string;
  message: AgentMessage;
}

export type ConversationEntry = PersistedConversationEntry | LiveConversationEntry;

export interface MessageRecordPage {
  items: PersistedConversationEntry[];
  pageInfo: {
    hasPreviousPage: boolean;
    previousCursor: string | null;
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

interface ConversationState extends Omit<ChatState, "isStreaming" | "messages"> {
  records: PersistedConversationEntry[];
  liveTail: LiveConversationEntry[];
  previousCursor: string | null;
  latestCursor: string | null;
}

interface ConversationUpdate extends Partial<Omit<ConversationState, "records">> {
  /** Records are always merged by ID and ordered by parent links. */
  records?: PersistedConversationEntry[];
}

export interface ConversationView extends Omit<ChatState, "isStreaming"> {
  entries: ConversationEntry[];
  hasEarlierMessages: boolean;
}

type ConversationsStoreListener = () => void;

interface ConversationsStoreOptions {
  sessionCache?: SessionCache;
}

function blankConversationState(): ConversationState {
  const state = initialChatState();
  return {
    records: [],
    liveTail: [],
    previousCursor: null,
    latestCursor: null,
    streamingBlocks: state.streamingBlocks,
    isCompacting: state.isCompacting,
    errorMessage: state.errorMessage,
  };
}

/** Merge page records and derive their linear display order from parent links. */
function mergeMessageRecords(...recordSets: PersistedConversationEntry[][]): PersistedConversationEntry[] {
  const records = new Map<string, PersistedConversationEntry>();
  for (const record of recordSets.flat()) records.set(record.id, record);

  const ordered: PersistedConversationEntry[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (record: PersistedConversationEntry) => {
    if (visited.has(record.id)) return;
    if (visiting.has(record.id)) return;
    visiting.add(record.id);
    if (record.parentId) {
      const parent = records.get(record.parentId);
      if (parent) visit(parent);
    }
    visiting.delete(record.id);
    visited.add(record.id);
    ordered.push(record);
  };

  for (const record of records.values()) visit(record);
  return ordered;
}

export class ConversationsStore {
  private _states = new Map<string, ConversationState>();
  private _listeners = new Map<string, Set<ConversationsStoreListener>>();
  private _sessionCache: SessionCache | null;
  private _unsubscribeSessionCache: (() => void) | null = null;
  private _nextLiveEntryId = 1;

  constructor(options: ConversationsStoreOptions = {}) {
    this._sessionCache = options.sessionCache ?? null;
    this._unsubscribeSessionCache = this._sessionCache?.subscribeAll((sessionId) => {
      this.pruneSessionIfInactive(sessionId);
    }) ?? null;
  }

  get(sessionId: string): ConversationView {
    const state = sessionId ? this.stateFor(sessionId) : blankConversationState();
    const entries = this.displayEntries(state);
    return {
      entries,
      messages: entries.map((entry) => entry.message),
      hasEarlierMessages: state.previousCursor !== null,
      streamingBlocks: state.streamingBlocks,
      isCompacting: state.isCompacting,
      errorMessage: state.errorMessage,
    };
  }

  async syncMessages(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/messages`;
    let after = this.stateFor(sessionId).latestCursor;

    try {
      while (true) {
        const url = after === null ? path : `${path}?after=${encodeURIComponent(after)}`;
        const response = await fetch(url);
        if (!response.ok) return false;
        const page: MessageRecordPage = await response.json();
        this.mergeMessages(sessionId, page);
        if (!page.pageInfo.hasNextPage) return true;
        if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after) return false;
        after = page.pageInfo.endCursor;
      }
    } catch {
      return false;
    }
  }

  async loadEarlierMessages(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    const before = this.stateFor(sessionId).previousCursor;
    if (!before) return false;

    try {
      const path = `/api/sessions/${encodeURIComponent(sessionId)}/messages`;
      const response = await fetch(`${path}?before=${encodeURIComponent(before)}`);
      if (!response.ok) return false;
      const page: MessageRecordPage = await response.json();
      this.mergeMessages(sessionId, page, { earlier: true });
      return true;
    } catch {
      return false;
    }
  }

  subscribe(sessionId: string, listener: ConversationsStoreListener): () => void {
    if (!sessionId) return () => {};
    let listeners = this._listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this._listeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this._listeners.delete(sessionId);
        this.pruneSessionIfInactive(sessionId);
      }
    };
  }

  addOptimisticUserMessage(
    sessionId: string,
    content: ClientPromptContent,
    timestamp = Date.now(),
  ): LiveConversationEntry | null {
    if (!sessionId) return null;
    const entry: LiveConversationEntry = {
      id: null,
      parentId: null,
      localId: `live-${this._nextLiveEntryId++}`,
      message: { role: "user", content, timestamp },
    };
    this.update(sessionId, (state) => ({ liveTail: [...state.liveTail, entry] }));
    return entry;
  }

  mergeMessages(
    sessionId: string,
    page: MessageRecordPage,
    options: { earlier?: boolean } = {},
  ): void {
    if (!sessionId) return;
    this.update(sessionId, (state) => {
      if (options.earlier) {
        return {
          records: page.items,
          previousCursor: page.pageInfo.previousCursor,
        };
      }

      const known = new Set(state.records.map(({ id }) => id));
      const added = page.items.filter(({ id }) => !known.has(id));
      return {
        records: page.items,
        liveTail: this.removePersistedLiveEntries(state.liveTail, added),
        previousCursor: state.records.length === 0 ? page.pageInfo.previousCursor : state.previousCursor,
        latestCursor: page.pageInfo.endCursor,
        streamingBlocks: state.records.length > 0 && added.length > 0 ? [] : state.streamingBlocks,
      };
    });
  }

  applyEvent(sessionId: string, event: FrontendEvent): void {
    if (!sessionId) return;

    switch (event.type) {
      case "agent_start":
      case "message_update":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
      case "agent_end":
      case "message_end":
      case "compaction_start":
      case "compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
      case "user_message": {
        this.update(sessionId, (state) => {
          if (
            event.type === "user_message"
            && state.liveTail.some((entry) => (
              entry.message.role === "user"
              && userMessageContentKey(entry.message.content) === userMessageContentKey(event.message)
            ))
          ) return undefined;

          const reconciledState = event.type === "agent_end" && event.messages
            ? this.reconcileFinalizedUserMessages(state, event.messages)
            : state;
          const messages = this.displayMessages(reconciledState);
          const next = applyChatEvent({ ...reconciledState, messages, isStreaming: false }, event);
          if (
            reconciledState === state
            && next.messages === messages
            && next.streamingBlocks === state.streamingBlocks
            && next.isCompacting === state.isCompacting
            && next.errorMessage === state.errorMessage
          ) return undefined;

          return {
            liveTail: this.liveEntriesForMessages(
              reconciledState.liveTail,
              next.messages.slice(reconciledState.records.length),
            ),
            streamingBlocks: next.streamingBlocks,
            isCompacting: next.isCompacting,
            errorMessage: next.errorMessage,
          };
        });
        return;
      }
      case "ws_error":
        this.setError(sessionId, event.error || "Something went wrong");
        return;
      default:
        return;
    }
  }

  clearStreamingState(sessionId: string): void {
    if (!sessionId) return;
    this.update(sessionId, (state) => (
      state.streamingBlocks.length === 0 && !state.isCompacting
        ? undefined
        : { streamingBlocks: [], isCompacting: false }
    ));
  }

  setError(sessionId: string, errorMessage: string): void {
    if (!sessionId) return;
    this.update(sessionId, { errorMessage });
  }

  clearError(sessionId: string): void {
    this.setError(sessionId, "");
  }

  pruneInactive(): void {
    for (const sessionId of this._states.keys()) {
      this.pruneSessionIfInactive(sessionId);
    }
  }

  dispose(): void {
    this._unsubscribeSessionCache?.();
    this._unsubscribeSessionCache = null;
    this._listeners.clear();
    this._states.clear();
  }

  private pruneSessionIfInactive(sessionId: string): void {
    if (!this._states.has(sessionId)) return;
    if (this._listeners.has(sessionId)) return;
    if (this._sessionCache?.get(sessionId)?.activityState === "running") return;
    this.evict(sessionId);
  }

  private evict(sessionId: string): void {
    if (!this._states.delete(sessionId)) return;
    this.notify(sessionId);
  }

  private displayEntries(state: ConversationState): ConversationEntry[] {
    return [...state.records, ...state.liveTail];
  }

  private displayMessages(state: ConversationState): AgentMessage[] {
    return this.displayEntries(state).map(({ message }) => message);
  }

  private reconcileFinalizedUserMessages(
    state: ConversationState,
    messages: readonly AgentMessage[],
  ): ConversationState {
    const liveTail = [...state.liveTail];
    const matched = new Set<number>();
    let changed = false;
    for (const message of messages) {
      if (message.role !== "user") continue;
      const match = liveTail.findIndex((entry, index) => (
        !matched.has(index)
        && entry.message.role === "user"
        && userMessageContentKey(entry.message.content) === userMessageContentKey(message.content)
      ));
      if (match === -1) continue;
      matched.add(match);
      liveTail[match] = { ...liveTail[match], message };
      changed = true;
    }
    return changed ? { ...state, liveTail } : state;
  }

  private removePersistedLiveEntries(
    liveEntries: readonly LiveConversationEntry[],
    records: readonly PersistedConversationEntry[],
  ): LiveConversationEntry[] {
    const remaining = [...liveEntries];
    for (const record of records) {
      const match = remaining.findIndex(({ message }) => (
        message.role === record.message.role
        && (message.role === "user" && record.message.role === "user"
          ? userMessageContentKey(message.content) === userMessageContentKey(record.message.content)
          : message.timestamp === record.message.timestamp)
      ));
      if (match !== -1) remaining.splice(match, 1);
    }
    return remaining;
  }

  private liveEntriesForMessages(
    existing: readonly LiveConversationEntry[],
    messages: readonly AgentMessage[],
  ): LiveConversationEntry[] {
    return messages.map((message) => {
      const current = existing.find((entry) => entry.message === message);
      return current ?? {
        id: null,
        parentId: null,
        localId: `live-${this._nextLiveEntryId++}`,
        message,
      };
    });
  }

  private stateFor(sessionId: string): ConversationState {
    return this._states.get(sessionId) ?? blankConversationState();
  }

  private update(
    sessionId: string,
    build: ConversationUpdate | ((state: ConversationState) => ConversationUpdate | undefined),
  ): void {
    const current = this.stateFor(sessionId);
    const patch = typeof build === "function" ? build(current) : build;
    if (!patch) return;

    const { records, ...rest } = patch;
    this._states.set(sessionId, {
      ...current,
      ...rest,
      records: records ? mergeMessageRecords(current.records, records) : current.records,
    });
    this.notify(sessionId);
  }

  private notify(sessionId: string): void {
    const listeners = this._listeners.get(sessionId);
    if (!listeners) return;
    for (const listener of listeners) listener();
  }
}
