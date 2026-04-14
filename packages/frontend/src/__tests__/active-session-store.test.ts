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

// ---- Helpers ----------------------------------------------------------------

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

function makeSessionData(overrides: { isStreaming?: boolean; messageCount?: number; projectId?: number; runtimeType?: string } = {}) {
  return {
    id: "sess-1",
    task_id: null,
    project_id: overrides.projectId ?? 42,
    runtimeType: overrides.runtimeType ?? "pi",
    state: {
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      thinkingLevel: "high",
      isStreaming: overrides.isStreaming ?? false,
      messageCount: overrides.messageCount ?? 0,
    },
  };
}

describe("ActiveSessionStore.updateSessionModel", () => {
  beforeEach(() => {
    restoreFetch();
    mockFetch((url, init) => {
      if (url === "/api/sessions/sess-1/model" && init?.method === "PUT") {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  });

  afterEach(() => { restoreFetch(); });

  test("persists the session model and updates local session state", async () => {
    const store = new ActiveSessionStore();
    store.sessionId = "sess-1";
    store.sessionData = makeSessionData();

    const result = await store.updateSessionModel({
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "medium",
      runtimeType: "pi",
    });

    expect(result).toEqual({ ok: true });
    expect(store.sessionData?.state.model).toEqual({ provider: "openai", id: "gpt-5" });
    expect(store.sessionData?.state.thinkingLevel).toBe("medium");
    expect(store.sessionData?.runtimeType).toBe("pi");
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

const twoMessages: AgentMessage[] = [
  { role: "user", content: "hello", timestamp: 1000 },
  { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2000 },
];

describe("ActiveSessionStore session loading contract", () => {
  afterEach(() => { restoreFetch(); });

  test("setRoute starts metadata and messages fetches in parallel", async () => {
    const store = new ActiveSessionStore();
    const calls: string[] = [];
    let resolveSession!: (response: Response) => void;

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1") return new Promise<Response>((r) => { resolveSession = r; });
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(twoMessages);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const routePromise = store.setRoute("sess-1");
    await Promise.resolve();

    expect(calls).toEqual(["/api/sessions/sess-1", "/api/sessions/sess-1/messages"]);

    resolveSession(jsonResponse(makeSessionData({ isStreaming: true, messageCount: 2 })));
    await routePromise;

    expect(store.projectId).toBe(42);
    expect(store.sessionMessages).toEqual(twoMessages);
  });

  test("refreshSession does not invalidate an in-flight initial messages load", async () => {
    const store = new ActiveSessionStore();
    let resolveMessages!: (value: Response) => void;

    mockFetch((url) => {
      if (url === "/api/sessions/sess-1") return jsonResponse(makeSessionData({ messageCount: 2 }));
      if (url === "/api/sessions/sess-1/messages") return new Promise<Response>((r) => { resolveMessages = r; });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const routePromise = store.setRoute("sess-1");
    await Promise.resolve();
    await Promise.resolve();
    await store.refreshSession();

    resolveMessages(jsonResponse(twoMessages));
    await routePromise;

    expect(store.sessionMessages).toEqual(twoMessages);
  });

  test("refreshSession auto-refreshes messages when isStreaming transitions to false", async () => {
    const store = new ActiveSessionStore();
    const calls: string[] = [];

    store.sessionId = "sess-1";
    store.sessionData = makeSessionData({ isStreaming: true, messageCount: 1 });
    store.sessionMessages = [{ role: "user", content: "hello", timestamp: 1000 }];

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1") return jsonResponse(makeSessionData({ messageCount: 3 }));
      if (url === "/api/sessions/sess-1/messages") return jsonResponse([
        { role: "user", content: "hello", timestamp: 1000 },
        { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2000 },
        { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "output" }], isError: false, timestamp: 3000 },
      ]);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.refreshSession();

    expect(calls).toContain("/api/sessions/sess-1");
    expect(calls).toContain("/api/sessions/sess-1/messages");
    expect(store.sessionData.state.isStreaming).toBe(false);
    expect(store.sessionMessages).toHaveLength(3);
  });

  test("refreshSession does NOT auto-refresh messages when still streaming", async () => {
    const store = new ActiveSessionStore();
    const calls: string[] = [];

    store.sessionId = "sess-1";
    store.sessionData = makeSessionData({ isStreaming: true, messageCount: 1 });

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1") return jsonResponse(makeSessionData({ isStreaming: true, messageCount: 2 }));
      if (url === "/api/sessions/sess-1/messages") throw new Error("Should not fetch messages when still streaming");
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.refreshSession();
    expect(calls).toEqual(["/api/sessions/sess-1"]);
  });

  test("clearing the route resets session data to a blank session", async () => {
    const store = new ActiveSessionStore();
    store.projectId = 42;
    store.sessionId = "sess-1";
    store.sessionData = makeSessionData({ isStreaming: true, messageCount: 3 });
    store.sessionMessages = [{ role: "user", content: "hello", timestamp: 1000 }];

    await store.setRoute(null);

    expect(store.projectId).toBeNull();
    expect(store.sessionId).toBe("");
    expect(store.sessionData.state.isStreaming).toBe(false);
    expect(store.sessionMessages).toEqual([]);
  });
});
