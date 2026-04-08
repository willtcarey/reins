import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentMessage } from "../models/chat-state.js";
import { ActiveSessionStore } from "../models/stores/active-session-store.js";
import { StubClient } from "./helpers/stub-client.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";

type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;
type AssertTrue<T extends true> = T;
type _SessionMessagesElementIsTyped = AssertFalse<IsAny<ActiveSessionStore["sessionMessages"][number]>>;
type _SessionMessagesMatchAgentMessages = AssertTrue<ActiveSessionStore["sessionMessages"] extends AgentMessage[] ? true : false>;

describe("ActiveSessionStore.updateSessionModel", () => {
  beforeEach(() => {
    restoreFetch();

    mockFetch((url, init) => {
      if (url === "/api/sessions/sess-1/model" && init?.method === "PUT") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  });

  afterEach(() => {
    restoreFetch();
  });

  test("persists the session model and updates local session state", async () => {
    const store = new ActiveSessionStore();
    store.sessionId = "sess-1";
    store.sessionData = {
      id: "sess-1",
      task_id: null,
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

describe("ActiveSessionStore command helpers", () => {
  test("prompt, steer, and abort target the active session", () => {
    const client = new StubClient();
    client.prompt = mock(() => {});
    client.steer = mock(() => {});
    client.abort = mock(() => {});

    const store = new ActiveSessionStore(client);
    store.sessionId = "sess-1";

    expect(store.prompt("hello")).toBe(true);
    expect(store.steer("keep going")).toBe(true);
    expect(store.abort()).toBe(true);

    expect(client.prompt).toHaveBeenCalledWith("sess-1", "hello");
    expect(client.steer).toHaveBeenCalledWith("sess-1", "keep going");
    expect(client.abort).toHaveBeenCalledWith("sess-1");
  });

  test("command helpers return false without an active session", () => {
    const client = new StubClient();
    client.prompt = mock(() => {});
    client.steer = mock(() => {});
    client.abort = mock(() => {});

    const store = new ActiveSessionStore(client);

    expect(store.prompt("hello")).toBe(false);
    expect(store.steer("keep going")).toBe(false);
    expect(store.abort()).toBe(false);

    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.steer).not.toHaveBeenCalled();
    expect(client.abort).not.toHaveBeenCalled();
  });
});

describe("ActiveSessionStore session loading contract", () => {
  afterEach(() => {
    restoreFetch();
  });

  test("setRoute starts metadata and messages fetches in parallel", async () => {
    const store = new ActiveSessionStore();
    const calls: string[] = [];
    let resolveSession!: (response: Response) => void;

    mockFetch((url) => {
      calls.push(url);

      if (url === "/api/sessions/sess-1") {
        return new Promise<Response>((resolve) => {
          resolveSession = resolve;
        });
      }

      if (url === "/api/sessions/sess-1/messages") {
        return new Response(JSON.stringify([
          { role: "user", content: "hello", timestamp: 1000 },
          {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            timestamp: 2000,
          },
        ]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const routePromise = store.setRoute("sess-1");

    await Promise.resolve();

    expect(store.sessionData).toEqual({
      id: "sess-1",
      task_id: null,
      state: {
        model: null,
        thinkingLevel: "high",
        isStreaming: false,
        messageCount: 0,
      },
    });
    expect(calls).toEqual([
      "/api/sessions/sess-1",
      "/api/sessions/sess-1/messages",
    ]);

    resolveSession(new Response(JSON.stringify({
      id: "sess-1",
      task_id: null,
      project_id: 42,
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "high",
        isStreaming: true,
        messageCount: 2,
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await routePromise;

    expect(store.projectId).toBe(42);
    expect(store.sessionMessages).toEqual([
      { role: "user", content: "hello", timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        timestamp: 2000,
      },
    ]);
  });

  test("refreshSession does not invalidate an in-flight initial messages load", async () => {
    const store = new ActiveSessionStore();
    let resolveMessages!: (value: Response) => void;

    mockFetch((url) => {
      if (url === "/api/sessions/sess-1") {
        return new Response(JSON.stringify({
          id: "sess-1",
          task_id: null,
          project_id: 42,
          state: {
            model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
            thinkingLevel: "high",
            isStreaming: false,
            messageCount: 2,
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url === "/api/sessions/sess-1/messages") {
        return new Promise<Response>((resolve) => {
          resolveMessages = resolve;
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const routePromise = store.setRoute("sess-1");

    await Promise.resolve();
    await Promise.resolve();

    await store.refreshSession();

    resolveMessages(new Response(JSON.stringify([
      { role: "user", content: "hello", timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        timestamp: 2000,
      },
    ]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await routePromise;

    expect(store.sessionMessages).toEqual([
      { role: "user", content: "hello", timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        timestamp: 2000,
      },
    ]);
  });

  test("clearing the route resets session data to a blank session", async () => {
    const store = new ActiveSessionStore();
    store.projectId = 42;
    store.sessionId = "sess-1";
    store.sessionData = {
      id: "sess-1",
      task_id: 7,
      state: {
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        thinkingLevel: "medium",
        isStreaming: true,
        messageCount: 3,
      },
    };
    store.sessionMessages = [
      { role: "user", content: "hello", timestamp: 1000 },
    ];

    await store.setRoute(null);

    expect(store.projectId).toBeNull();
    expect(store.sessionId).toBe("");
    expect(store.sessionData).toEqual({
      id: "",
      task_id: null,
      state: {
        model: null,
        thinkingLevel: "high",
        isStreaming: false,
        messageCount: 0,
      },
    });
    expect(store.sessionMessages).toEqual([]);
  });
});
