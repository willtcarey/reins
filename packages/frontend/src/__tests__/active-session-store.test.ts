import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentMessage } from "../models/chat-state.js";
import { ActiveSessionStore } from "../models/stores/active-session-store.js";
import { SessionCache } from "../models/stores/session-cache.js";
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
  const messageCount = overrides.messageCount ?? 0;
  return {
    id: "sess-1",
    projectId: overrides.projectId ?? 42,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: "",
    updatedAt: "",
    runtimeType: overrides.runtimeType ?? "pi",
    activityState: null,
    messageCount,
    state: {
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      thinkingLevel: "high",
      isStreaming: overrides.isStreaming ?? false,
      messageCount,
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

describe("ActiveSessionStore.uploadAttachments", () => {
  afterEach(() => { restoreFetch(); });

  test("posts files through the active session store boundary", async () => {
    const store = new ActiveSessionStore();
    store.sessionId = "sess-1";
    const uploadState: { form?: FormData } = {};

    mockFetch((url, init) => {
      expect(url).toBe("/api/sessions/sess-1/attachments");
      expect(init?.method).toBe("POST");
      if (!(init?.body instanceof FormData)) throw new Error("Expected FormData upload body");
      uploadState.form = init.body;
      return jsonResponse({
        attachments: [{
          id: "att_1",
          kind: "image",
          mimeType: "image/png",
          filename: "screen.png",
          byteSize: 9,
          sha256: "abc",
          url: "/api/sessions/sess-1/attachments/att_1",
          width: 640,
          height: 480,
        }],
      });
    });

    const result = await store.uploadAttachments([
      { file: new File(["png bytes"], "screen.png", { type: "image/png" }), mimeType: "image/png", filename: "screen.png" },
    ]);

    const form = uploadState.form;
    if (!form) throw new Error("Expected upload form");
    expect(form.getAll("files")).toHaveLength(1);
    expect(form.get("metadata")).toBeNull();
    expect(result).toEqual([{
      id: "att_1",
      kind: "image",
      mimeType: "image/png",
      filename: "screen.png",
      byteSize: 9,
      sha256: "abc",
      url: "/api/sessions/sess-1/attachments/att_1",
      width: 640,
      height: 480,
    }]);
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

    expect(store.prompt([{ type: "text", text: "hello" }])).toBe(true);
    expect(store.steer([{ type: "text", text: "keep going" }])).toBe(true);
    expect(store.abort()).toBe(true);

    expect(client.prompt).toHaveBeenCalledWith("sess-1", [{ type: "text", text: "hello" }]);
    expect(client.steer).toHaveBeenCalledWith("sess-1", [{ type: "text", text: "keep going" }]);
    expect(client.abort).toHaveBeenCalledWith("sess-1");
  });

  test("command helpers return false without an active session", () => {
    const client = new StubClient();
    client.prompt = mock(() => {});
    client.steer = mock(() => {});
    client.abort = mock(() => {});

    const store = new ActiveSessionStore(client);

    expect(store.prompt([{ type: "text", text: "hello" }])).toBe(false);
    expect(store.steer([{ type: "text", text: "keep going" }])).toBe(false);
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

  test("setRoute reads cached metadata from SessionCache and only fetches messages", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore(null, sessionCache);
    const calls: string[] = [];
    sessionCache.set("sess-1", makeSessionData({ messageCount: 2 }));

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(twoMessages);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.setRoute("sess-1");

    expect(calls).toEqual(["/api/sessions/sess-1/messages"]);
    expect(store.projectId).toBe(42);
    expect(store.sessionData.messageCount).toBe(2);
    expect(store.sessionMessages).toEqual(twoMessages);
  });

  test("setRoute leaves metadata blank when SessionCache has no detail", async () => {
    const store = new ActiveSessionStore(null, new SessionCache());
    const calls: string[] = [];
    store.projectId = 42;
    store.sessionId = "previous";
    store.sessionData = makeSessionData({ projectId: 42 });

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(twoMessages);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.setRoute("sess-1");

    expect(calls).toEqual(["/api/sessions/sess-1/messages"]);
    expect(store.projectId).toBeNull();
    expect(store.sessionData).toEqual({
      ...makeSessionData({ messageCount: 0, projectId: 0, runtimeType: undefined }),
      id: "sess-1",
      runtimeType: undefined,
      state: { model: null, thinkingLevel: "high", isStreaming: false, messageCount: 0 },
    });
    expect(store.sessionMessages).toEqual(twoMessages);
  });

  test("subscribes to SessionCache updates for the active session", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore(null, sessionCache);

    mockFetch((url) => {
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(twoMessages);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.setRoute("sess-1");
    expect(store.projectId).toBeNull();

    sessionCache.set("sess-1", makeSessionData({ messageCount: 5 }));

    expect(store.projectId).toBe(42);
    expect(store.sessionData.messageCount).toBe(5);
  });

  test("ignores SessionCache updates for other sessions", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore(null, sessionCache);

    mockFetch((url) => {
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(twoMessages);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.setRoute("sess-1");
    sessionCache.set("sess-2", makeSessionData({ projectId: 99 }));

    expect(store.projectId).toBeNull();
    expect(store.sessionData.id).toBe("sess-1");
  });

  test("refreshSession does not invalidate an in-flight initial messages load", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore(null, sessionCache);
    let resolveMessages!: (value: Response) => void;
    sessionCache.set("sess-1", makeSessionData({ messageCount: 2 }));

    mockFetch((url) => {
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

  test("refreshSession auto-refreshes messages when cached isStreaming transitions to false", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore(null, sessionCache);
    const calls: string[] = [];

    store.sessionId = "sess-1";
    store.sessionData = makeSessionData({ isStreaming: true, messageCount: 1 });
    store.sessionMessages = [{ role: "user", content: "hello", timestamp: 1000 }];
    sessionCache.set("sess-1", makeSessionData({ messageCount: 3 }));

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1/messages") return jsonResponse([
        { role: "user", content: "hello", timestamp: 1000 },
        { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2000 },
        { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "output" }], isError: false, timestamp: 3000 },
      ]);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.refreshSession();

    expect(calls).toEqual(["/api/sessions/sess-1/messages"]);
    expect(store.sessionData.state.isStreaming).toBe(false);
    expect(store.sessionMessages).toHaveLength(3);
  });

  test("refreshSession does NOT auto-refresh messages when cached session is still streaming", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore(null, sessionCache);
    const calls: string[] = [];

    store.sessionId = "sess-1";
    store.sessionData = makeSessionData({ isStreaming: true, messageCount: 1 });
    sessionCache.set("sess-1", makeSessionData({ isStreaming: true, messageCount: 2 }));

    mockFetch((url) => {
      calls.push(url);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.refreshSession();
    expect(calls).toEqual([]);
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
