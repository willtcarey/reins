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
} from "../chat-state.js";
import type { FrontendEvent } from "../ws-client.js";
import type { SessionCache } from "./session-cache.js";

export interface SessionConversationState extends Omit<ChatState, "isStreaming"> {
  /** Last persisted full-message snapshot loaded for this session. */
  persistedMessages: AgentMessage[];
}

export type ConversationsStoreListener = () => void;

export interface ConversationsStoreOptions {
  sessionCache?: SessionCache;
}

function blankConversationState(): SessionConversationState {
  const state = initialChatState();
  return {
    messages: state.messages,
    streamingBlocks: state.streamingBlocks,
    isCompacting: state.isCompacting,
    errorMessage: state.errorMessage,
    persistedMessages: [],
  };
}

function latestMessageTimestamp(messages: AgentMessage[]): number {
  return messages.reduce((latest, message) => Math.max(latest, message.timestamp), -Infinity);
}

export class ConversationsStore {
  private _states = new Map<string, SessionConversationState>();
  private _listeners = new Map<string, Set<ConversationsStoreListener>>();
  private _sessionCache: SessionCache | null;
  private _unsubscribeSessionCache: (() => void) | null = null;

  constructor(options: ConversationsStoreOptions = {}) {
    this._sessionCache = options.sessionCache ?? null;
    this._unsubscribeSessionCache = this._sessionCache?.subscribeAll((sessionId) => {
      this.pruneSessionIfInactive(sessionId);
    }) ?? null;
  }

  get(sessionId: string): SessionConversationState {
    if (!sessionId) return blankConversationState();
    return this.ensure(sessionId);
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

  setPersistedMessages(sessionId: string, persistedMessages: AgentMessage[]): void {
    if (!sessionId) return;
    const state = this.ensure(sessionId);
    const persistedSnapshotAdvanced = state.messages.length > 0
      && latestMessageTimestamp(persistedMessages) > latestMessageTimestamp(state.messages);

    this.set(sessionId, {
      ...state,
      persistedMessages,
      streamingBlocks: persistedSnapshotAdvanced ? [] : state.streamingBlocks,
      messages: persistedMessages,
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
        const state = this.ensure(sessionId);
        const next = applyChatEvent({ ...state, isStreaming: false }, event);
        if (
          next.messages === state.messages
          && next.streamingBlocks === state.streamingBlocks
          && next.isCompacting === state.isCompacting
          && next.errorMessage === state.errorMessage
        ) return;
        this.set(sessionId, {
          ...state,
          messages: next.messages,
          streamingBlocks: next.streamingBlocks,
          isCompacting: next.isCompacting,
          errorMessage: next.errorMessage,
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
    const state = this.ensure(sessionId);
    if (state.streamingBlocks.length === 0) return;
    this.set(sessionId, {
      ...state,
      streamingBlocks: [],
      messages: state.persistedMessages,
    });
  }

  setError(sessionId: string, errorMessage: string): void {
    if (!sessionId) return;
    const state = this.ensure(sessionId);
    this.set(sessionId, { ...state, errorMessage });
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

  private ensure(sessionId: string): SessionConversationState {
    let state = this._states.get(sessionId);
    if (!state) {
      state = blankConversationState();
      this._states.set(sessionId, state);
    }
    return state;
  }

  private set(sessionId: string, state: SessionConversationState): void {
    this._states.set(sessionId, state);
    this.notify(sessionId);
  }

  private notify(sessionId: string): void {
    const listeners = this._listeners.get(sessionId);
    if (!listeners) return;
    for (const listener of listeners) listener();
  }
}
