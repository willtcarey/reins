/**
 * Test Runtime Stub
 *
 * Lightweight stub of the AgentRuntime interface for unit tests.
 * Supports emitting events to subscribers and configurable message snapshots.
 *
 * Usage:
 *   const { runtime, emit } = createRuntimeStub();
 *   emit({ type: "agent_start" });
 */

import type { AgentRuntime, AgentRuntimeEvent } from "../../runtimes/registry.js";
import type { ClientPromptContent, RuntimeMessage } from "../../messages-store.js";

export interface RuntimeStubOptions {
  /** Messages returned by getMessages() */
  messages?: RuntimeMessage[];
  /** Whether isStreaming() returns true */
  isStreaming?: boolean;
}

export interface RuntimeStub {
  runtime: AgentRuntime;
  /** Emit an event to all subscribers */
  emit(event: AgentRuntimeEvent): void;
  /** Number of times getMessages() was called */
  getMessagesCalls: number;
  /** Arguments passed to prompt() calls, in order */
  promptCalls: ClientPromptContent[];
  /** Arguments passed to steer() calls, in order */
  steerCalls: ClientPromptContent[];
  /** Whether abort() was called */
  abortCalled: boolean;
}

export function createRuntimeStub(options: RuntimeStubOptions = {}): RuntimeStub {
  const { messages = [], isStreaming = false } = options;
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  let getMessagesCalls = 0;
  const promptCalls: ClientPromptContent[] = [];
  const steerCalls: ClientPromptContent[] = [];
  let abortCalled = false;

  const runtime: AgentRuntime = {
    async prompt(content: ClientPromptContent) {
      promptCalls.push(content);
    },
    async steer(content: ClientPromptContent) {
      steerCalls.push(content);
    },
    async abort() {
      abortCalled = true;
    },
    async setModel() {},
    subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async getMessages(): Promise<RuntimeMessage[]> {
      getMessagesCalls += 1;
      return messages.map((m) => ({ ...m }));
    },
    isStreaming(): boolean { return isStreaming; },
    async close() {},
  };

  return {
    runtime,
    get getMessagesCalls() { return getMessagesCalls; },
    get promptCalls() { return promptCalls; },
    get steerCalls() { return steerCalls; },
    get abortCalled() { return abortCalled; },
    emit(event: AgentRuntimeEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}
