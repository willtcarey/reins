import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { ActiveSessionStore } from "../models/stores/active-session-store.js";

const originalFetch = globalThis.fetch;

describe("ActiveSessionStore.updateSessionModel", () => {

  beforeEach(() => {
    const mockedFetch: typeof fetch = Object.assign(
      mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/sessions/sess-1/model" && init?.method === "PUT") {
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
      { preconnect(_url: string | URL) {} },
    );
    globalThis.fetch = mockedFetch;
  });

  test("persists the session model and updates local session state", async () => {
    const store = new ActiveSessionStore();
    store.sessionId = "sess-1";
    store.sessionData = {
      id: "sess-1",
      task_id: null,
      messages: [],
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "high",
        isStreaming: false,
        messageCount: 0,
      },
    };

    const result = await store.updateSessionModel({
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "medium",
    });

    expect(result).toEqual({ ok: true });
    expect(store.sessionData?.state.model).toEqual({ provider: "openai", id: "gpt-5" });
    expect(store.sessionData?.state.thinkingLevel).toBe("medium");
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});
