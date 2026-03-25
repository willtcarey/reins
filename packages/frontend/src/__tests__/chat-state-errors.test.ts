/**
 * Tests for error handling in chat state reducer.
 *
 * Covers: agent_end with error messages, auto_retry_start/end events.
 */
import { describe, test, expect } from "bun:test";
import {
  applyChatEvent,
  initialChatState,
  type ChatState,
  type AgentMessage,
  type AssistantMessage,
} from "../models/chat-state.js";

function makeUserMsg(text: string, ts = 1000) {
  return { role: "user" as const, content: text, timestamp: ts };
}

function makeAssistantMsg(text: string, ts = 2000): AssistantMessage {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    timestamp: ts,
  };
}

function makeErrorAssistantMsg(errorMessage: string, ts = 2000): AssistantMessage {
  return {
    role: "assistant" as const,
    content: [],
    timestamp: ts,
    stopReason: "error",
    errorMessage,
  };
}

function applyEvents(state: ChatState, events: any[]): ChatState {
  return events.reduce((s: ChatState, e: any) => applyChatEvent(s, e), state);
}

// ---------------------------------------------------------------------------

describe("applyChatEvent — agent_end error handling", () => {
  test("agent_end with error assistant message sets errorMessage", () => {
    const user = makeUserMsg("hello");
    const errorMsg = makeErrorAssistantMsg("Anthropic overloaded_error: Server is overloaded");

    const messages: AgentMessage[] = [user];
    let state: ChatState = {
      ...initialChatState(),
      messages,
    };
    state = applyChatEvent(state, { type: "agent_start" });
    const runMessages: AgentMessage[] = [user, errorMsg];
    state = applyChatEvent(state, {
      type: "agent_end",
      messages: runMessages,
    });

    expect(state.isStreaming).toBe(false);
    expect(state.errorMessage).toBe("Anthropic overloaded_error: Server is overloaded");
  });

  test("agent_end with error assistant message does not append it to messages", () => {
    const user = makeUserMsg("hello");
    const errorMsg = makeErrorAssistantMsg("Server error");

    const messages: AgentMessage[] = [user];
    let state: ChatState = {
      ...initialChatState(),
      messages,
    };
    state = applyChatEvent(state, { type: "agent_start" });
    const runMessages: AgentMessage[] = [user, errorMsg];
    state = applyChatEvent(state, {
      type: "agent_end",
      messages: runMessages,
    });

    // Error messages should not be added to the conversation
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
  });

  test("agent_end with successful messages does not set errorMessage", () => {
    const user = makeUserMsg("hello");
    const assistant = makeAssistantMsg("hi there");

    const messages: AgentMessage[] = [user];
    let state: ChatState = {
      ...initialChatState(),
      messages,
    };
    state = applyChatEvent(state, { type: "agent_start" });
    const runMessages: AgentMessage[] = [user, assistant];
    state = applyChatEvent(state, {
      type: "agent_end",
      messages: runMessages,
    });

    expect(state.errorMessage).toBe("");
    expect(state.messages).toHaveLength(2);
  });

  test("agent_end with mixed messages before error still shows error", () => {
    const user = makeUserMsg("hello");
    const assistant = makeAssistantMsg("let me try", 1500);
    const errorMsg = makeErrorAssistantMsg("Rate limited", 2000);

    const messages: AgentMessage[] = [user];
    let state: ChatState = {
      ...initialChatState(),
      messages,
    };
    state = applyChatEvent(state, { type: "agent_start" });
    const runMessages: AgentMessage[] = [user, assistant, errorMsg];
    state = applyChatEvent(state, {
      type: "agent_end",
      messages: runMessages,
    });

    expect(state.errorMessage).toBe("Rate limited");
    // The good assistant message should still be appended, but not the error one
    expect(state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});

describe("applyChatEvent — auto_retry events", () => {
  test("auto_retry_start sets errorMessage with retry info", () => {
    let state = applyChatEvent(initialChatState(), { type: "agent_start" });
    state = applyChatEvent(state, {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 5000,
      errorMessage: "overloaded_error",
    });

    expect(state.errorMessage).toContain("Retrying");
    expect(state.errorMessage).toContain("1");
    expect(state.errorMessage).toContain("3");
    // Should still be streaming (agent hasn't ended)
    expect(state.isStreaming).toBe(true);
  });

  test("auto_retry_end success clears errorMessage", () => {
    let state = applyEvents(initialChatState(), [
      { type: "agent_start" },
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 5000,
        errorMessage: "overloaded_error",
      },
    ]);

    expect(state.errorMessage).not.toBe("");

    state = applyChatEvent(state, {
      type: "auto_retry_end",
      success: true,
      attempt: 1,
    });

    expect(state.errorMessage).toBe("");
  });

  test("auto_retry_end failure sets finalError", () => {
    let state = applyEvents(initialChatState(), [
      { type: "agent_start" },
      {
        type: "auto_retry_start",
        attempt: 3,
        maxAttempts: 3,
        delayMs: 5000,
        errorMessage: "overloaded_error",
      },
    ]);

    state = applyChatEvent(state, {
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "All retries exhausted: overloaded_error",
    });

    expect(state.errorMessage).toContain("All retries exhausted");
  });
});
