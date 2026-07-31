/**
 * Conversations Store
 *
 * Owns persisted, optimistic, and live conversation presentation per session.
 * Runtime activity belongs exclusively to SessionCache. Keeping reconciliation
 * here lets WebSocket events update inactive routes without duplicating
 * canonical/live merge rules in rendering components.
 */

import {
  applyChatEvent,
  initialChatState,
  removePersistedStreamingAssistants,
  type AgentMessage,
  type ChatState,
  type StreamingAssistant,
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

interface ConversationState extends Omit<ChatState, "messages"> {
  records: PersistedConversationEntry[];
  liveTail: LiveConversationEntry[];
  previousCursor: string | null;
  latestCursor: string | null;
}

interface ConversationUpdate extends Partial<Omit<ConversationState, "records">> {
  /** Records are always merged by ID and ordered by parent links. */
  records?: PersistedConversationEntry[];
}

export interface ConversationView {
  entries: ConversationEntry[];
  messages: AgentMessage[];
  hasEarlierMessages: boolean;
  streamingAssistants: StreamingAssistant[];
  isCompacting: boolean;
  errorMessage: string;
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
    streamingAssistants: state.streamingAssistants,
    isCompacting: state.isCompacting,
    errorMessage: state.errorMessage,
  };
}

/**
 * Merge pages by stable record ID, then derive display order from parent links.
 * This preserves graph order when overlapping or earlier pages arrive later.
 */
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
      streamingAssistants: state.streamingAssistants,
      isCompacting: state.isCompacting,
      errorMessage: state.errorMessage,
    };
  }

  /** Follow the persisted tail cursor through every available forward page. */
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

  /** Load history before the current boundary without reconciling the live tail. */
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

  /** Append a browser submission with a stable local identity until persistence catches up. */
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

  /**
   * Merge a persisted page and reconcile only the forward edge with optimistic
   * entries and live assistants; earlier-history pages cannot acknowledge them.
   */
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
      const records = mergeMessageRecords(state.records, page.items);
      const persistedAssistantTimestamps = new Set(
        records.flatMap(({ message }) => message.role === "assistant" ? [message.timestamp] : []),
      );
      // Persistence acknowledges assistants by snapshot timestamp. Unmatched
      // snapshots survive so a stale page cannot erase newer live work.
      const reconciled = removePersistedStreamingAssistants(state, persistedAssistantTimestamps);
      return {
        records: page.items,
        // Only records not already known by ID can acknowledge pending live
        // users. Stale and overlapping pages therefore leave them untouched.
        liveTail: this.removePersistedLiveEntries(state.liveTail, added),
        previousCursor: state.records.length === 0 ? page.pageInfo.previousCursor : state.previousCursor,
        latestCursor: page.pageInfo.endCursor,
        streamingAssistants: reconciled.streamingAssistants,
      };
    });
  }

  /** Apply a runtime event against the session's complete persisted-plus-live view. */
  applyEvent(sessionId: string, event: FrontendEvent): void {
    if (!sessionId) return;

    switch (event.type) {
      case "agent_start":
      case "message_start":
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
          const messages = this.displayMessages(state);
          const next = applyChatEvent({ ...state, messages }, event);
          if (
            next.messages === messages
            && next.streamingAssistants === state.streamingAssistants
            && next.isCompacting === state.isCompacting
            && next.errorMessage === state.errorMessage
          ) return undefined;

          return {
            // Convert the reducer's message tail back to owned live entries,
            // retaining local IDs for unchanged message objects.
            liveTail: this.liveEntriesForMessages(
              state.liveTail,
              next.messages.slice(state.records.length),
            ),
            streamingAssistants: next.streamingAssistants,
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

  clearCompactingState(sessionId: string): void {
    if (!sessionId) return;
    this.update(sessionId, (state) => (
      state.isCompacting ? { isCompacting: false } : undefined
    ));
  }

  setError(sessionId: string, errorMessage: string): void {
    if (!sessionId) return;
    this.update(sessionId, { errorMessage });
  }

  clearError(sessionId: string): void {
    this.setError(sessionId, "");
  }

  /** Evict only sessions with neither subscribers nor active runtime work. */
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

  /**
   * Consume newly persisted live entries by durable reconciliation rules:
   * users FIFO, tool results by call ID, and other messages by role/timestamp.
   */
  private removePersistedLiveEntries(
    liveEntries: readonly LiveConversationEntry[],
    records: readonly PersistedConversationEntry[],
  ): LiveConversationEntry[] {
    const remaining = [...liveEntries];
    for (const record of records) {
      let match: number;
      if (record.message.role === "user") {
        match = remaining.findIndex(({ message }) => message.role === "user");
      } else if (record.message.role === "toolResult") {
        const toolCallId = record.message.toolCallId;
        match = remaining.findIndex(({ message }) => (
          message.role === "toolResult" && message.toolCallId === toolCallId
        ));
      } else {
        match = remaining.findIndex(({ message }) => (
          message.role === record.message.role
          && message.timestamp === record.message.timestamp
        ));
      }
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

  /** Apply a state patch while keeping persisted records graph-merged and ordered. */
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
