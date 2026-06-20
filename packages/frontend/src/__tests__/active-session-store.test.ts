import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentMessage } from "../models/chat-state.js";
import { ActiveSessionStore } from "../models/stores/active-session-store.js";
import { ConversationsStore } from "../models/stores/conversations-store.js";
import { SessionCache } from "../models/stores/session-cache.js";
import { StubClient } from "./helpers/stub-client.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";

type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;
type AssertTrue<T extends true> = T;
type _ConversationMessagesElementIsTyped = AssertFalse<IsAny<ActiveSessionStore["conversation"]["persistedMessages"][number]>>;
type _ConversationMessagesMatchAgentMessages = AssertTrue<ActiveSessionStore["conversation"]["persistedMessages"] extends AgentMessage[] ? true : false>;

// ---- Helpers ----------------------------------------------------------------

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

function callPrivate(obj: object, key: string, ...args: unknown[]) {
  const fn = Reflect.get(obj, key);
  if (typeof fn !== "function") throw new Error(`${key} is not callable`);
  return Reflect.apply(fn, obj, args);
}

function makeSessionData(overrides: {
  messageCount?: number;
  projectId?: number;
  runtimeType?: string;
  activityState?: "running" | "finished" | null;
} = {}) {
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
    activityState: overrides.activityState ?? null,
    messageCount,
    state: {
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      thinkingLevel: "high",
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
      if (url === "/api/sessions/sess-1") {
        return jsonResponse({
          ...makeSessionData({ runtimeType: "pi" }),
          state: {
            model: { provider: "openai", id: "gpt-5" },
            thinkingLevel: "medium",
            messageCount: 0,
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  });

  afterEach(() => { restoreFetch(); });

  test("persists the session model and refreshes metadata from the server", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);
    sessionCache.set("sess-1", makeSessionData());

    const result = await store.updateSessionModel({
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "medium",
      runtimeType: "pi",
    });

    expect(result).toEqual({ ok: true });
    expect(sessionCache.getDetail("sess-1")?.state.model).toEqual({ provider: "openai", id: "gpt-5" });
    expect(sessionCache.getDetail("sess-1")?.state.thinkingLevel).toBe("medium");
    expect(sessionCache.getDetail("sess-1")?.runtimeType).toBe("pi");
    expect(store.sessionData.state.model).toEqual({ provider: "openai", id: "gpt-5" });
  });
});

describe("ActiveSessionStore.uploadAttachments", () => {
  afterEach(() => { restoreFetch(); });

  test("posts files through the active session store boundary", async () => {
    const store = new ActiveSessionStore("sess-1");
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

describe("ActiveSessionStore conversation notifications", () => {
  afterEach(() => { restoreFetch(); });

  test("optimistic message updates notify through the conversation subscription only", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);
    sessionCache.set("sess-1", makeSessionData());
    mockFetch((url) => {
      if (url === "/api/sessions/sess-1/messages") return jsonResponse([]);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();

    let notifyCount = 0;
    store.subscribe(() => { notifyCount += 1; });

    store.addOptimisticUserMessage([{ type: "text", text: "hello" }], 500);

    expect(notifyCount).toBe(1);
  });

  test("message refresh updates notify through the conversation subscription only", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);
    sessionCache.set("sess-1", makeSessionData());
    const responses: AgentMessage[][] = [[], twoMessages];
    mockFetch((url) => {
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(responses.shift() ?? []);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();

    let notifyCount = 0;
    store.subscribe(() => { notifyCount += 1; });

    await store.refreshMessages();

    expect(notifyCount).toBe(1);
    expect(store.conversation.persistedMessages).toEqual(twoMessages);
  });
});

describe("ActiveSessionStore command helpers", () => {
  test("prompt, steer, and abort target the active session", () => {
    const client = new StubClient();
    client.prompt = mock(() => {});
    client.steer = mock(() => {});
    client.abort = mock(() => {});

    const store = new ActiveSessionStore("sess-1", client);

    expect(store.prompt([{ type: "text", text: "hello" }])).toBe(true);
    expect(store.steer([{ type: "text", text: "keep going" }])).toBe(true);
    expect(store.abort()).toBe(true);

    expect(client.prompt).toHaveBeenCalledWith("sess-1", [{ type: "text", text: "hello" }]);
    expect(client.steer).toHaveBeenCalledWith("sess-1", [{ type: "text", text: "keep going" }]);
    expect(client.abort).toHaveBeenCalledWith("sess-1");
  });

  test("prompt optimistically marks cached activityState running", () => {
    const client = new StubClient();
    client.prompt = mock(() => {});
    const sessionCache = new SessionCache();
    sessionCache.set("sess-1", makeSessionData({ activityState: null }));
    const store = new ActiveSessionStore("sess-1", client, sessionCache);

    expect(store.prompt([{ type: "text", text: "hello" }])).toBe(true);

    expect(sessionCache.get("sess-1")?.activityState).toBe("running");
  });

});

const twoMessages: AgentMessage[] = [
  { role: "user", content: "hello", timestamp: 1000 },
  { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2000 },
];

describe("ActiveSessionStore session loading contract", () => {
  afterEach(() => { restoreFetch(); });

  test("initialize reads cached metadata from SessionCache and only fetches messages", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);
    const calls: string[] = [];
    sessionCache.set("sess-1", makeSessionData({ messageCount: 2 }));

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(twoMessages);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();

    expect(calls).toEqual(["/api/sessions/sess-1/messages"]);
    expect(store.projectId).toBe(42);
    expect(store.sessionData.messageCount).toBe(2);
    expect(store.conversation.persistedMessages).toEqual(twoMessages);
  });

  test("initialize leaves metadata blank when SessionCache has no detail", async () => {
    const store = new ActiveSessionStore("sess-1", null, new SessionCache());
    const calls: string[] = [];

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(twoMessages);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();

    expect(calls).toEqual(["/api/sessions/sess-1/messages"]);
    expect(store.projectId).toBeNull();
    expect(store.sessionData).toEqual({
      ...makeSessionData({ messageCount: 0, projectId: 0, runtimeType: undefined }),
      id: "sess-1",
      runtimeType: undefined,
      state: { model: null, thinkingLevel: "high" },
    });
    expect(store.conversation.persistedMessages).toEqual(twoMessages);
  });

  test("subscribes to SessionCache updates for the active session", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);

    mockFetch((url) => {
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(twoMessages);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();
    expect(store.projectId).toBeNull();

    sessionCache.set("sess-1", makeSessionData({ messageCount: 5 }));

    expect(store.projectId).toBe(42);
    expect(store.sessionData.messageCount).toBe(5);
  });

  test("ignores SessionCache updates for other sessions", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);

    mockFetch((url) => {
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(twoMessages);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();
    sessionCache.set("sess-2", makeSessionData({ projectId: 99 }));

    expect(store.projectId).toBeNull();
    expect(store.sessionData.id).toBe("sess-1");
  });

  test("session cache update does not invalidate an in-flight initial messages load", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);
    let resolveMessages!: (value: Response) => void;
    sessionCache.set("sess-1", makeSessionData({ messageCount: 2 }));

    mockFetch((url) => {
      if (url === "/api/sessions/sess-1/messages") return new Promise<Response>((r) => { resolveMessages = r; });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const routePromise = store.initialize();
    await Promise.resolve();
    await Promise.resolve();
    await callPrivate(store, "handleSessionCacheUpdate");

    resolveMessages(jsonResponse(twoMessages));
    await routePromise;

    expect(store.conversation.persistedMessages).toEqual(twoMessages);
  });

  test("dispose prevents an in-flight initial messages load from committing", async () => {
    const sessionCache = new SessionCache();
    const conversationsStore = new ConversationsStore();
    const store = new ActiveSessionStore("sess-1", null, sessionCache, conversationsStore);
    let resolveMessages!: (value: Response) => void;
    sessionCache.set("sess-1", makeSessionData({ messageCount: 2 }));

    mockFetch((url) => {
      if (url === "/api/sessions/sess-1/messages") return new Promise<Response>((r) => { resolveMessages = r; });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const initializePromise = store.initialize();
    await Promise.resolve();
    store.dispose();

    resolveMessages(jsonResponse(twoMessages));
    await initializePromise;

    expect(conversationsStore.get("sess-1").persistedMessages).toEqual([]);
  });

  test("session cache update auto-refreshes messages when cached activityState transitions from running", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);
    const calls: string[] = [];

    sessionCache.set("sess-1", makeSessionData({ activityState: "running", messageCount: 1 }));
    await callPrivate(store, "handleSessionCacheUpdate");

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1/messages") return jsonResponse([
        { role: "user", content: "hello", timestamp: 1000 },
        { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2000 },
        { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "output" }], isError: false, timestamp: 3000 },
      ]);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    sessionCache.set("sess-1", makeSessionData({ messageCount: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual(["/api/sessions/sess-1/messages"]);
    expect(store.sessionData.activityState).not.toBe("running");
    expect(store.conversation.persistedMessages).toHaveLength(3);
  });

  test("session cache update does NOT auto-refresh messages when cached session is still running", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);
    const calls: string[] = [];

    sessionCache.set("sess-1", makeSessionData({ activityState: "running", messageCount: 1 }));
    await callPrivate(store, "handleSessionCacheUpdate");
    sessionCache.set("sess-1", makeSessionData({ activityState: "running", messageCount: 2 }));

    mockFetch((url) => {
      calls.push(url);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await callPrivate(store, "handleSessionCacheUpdate");
    expect(calls).toEqual([]);
  });

  test("markViewed clears finished activity optimistically", async () => {
    const sessionCache = new SessionCache();
    sessionCache.set("sess-1", makeSessionData({ activityState: "finished" }));
    const store = new ActiveSessionStore("sess-1", null, sessionCache);

    const calls: Array<{ url: string; method: string }> = [];
    mockFetch((url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/sessions/sess-1/messages") return jsonResponse([]);
      if (url === "/api/sessions/sess-1/activity" && init?.method === "PATCH") return jsonResponse({ ok: true });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();
    expect(sessionCache.get("sess-1")?.activityState).toBeNull();
    expect(calls).toContainEqual({ url: "/api/sessions/sess-1/activity", method: "PATCH" });
  });

  test("markViewed rolls back finished activity if the server request fails", async () => {
    const sessionCache = new SessionCache();
    sessionCache.set("sess-1", makeSessionData({ activityState: "finished" }));
    const store = new ActiveSessionStore("sess-1", null, sessionCache);

    mockFetch((url, init) => {
      if (url === "/api/sessions/sess-1/messages") return jsonResponse([]);
      if (url === "/api/sessions/sess-1/activity" && init?.method === "PATCH") return new Response("fail", { status: 500 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sessionCache.get("sess-1")?.activityState).toBe("finished");
  });

  test("markViewed is a no-op when activity is not finished", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);
    sessionCache.set("sess-1", makeSessionData({ activityState: "running" }));

    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1/messages") return jsonResponse([]);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();
    await store.markViewed();

    expect(calls).toEqual(["/api/sessions/sess-1/messages"]);
    expect(sessionCache.get("sess-1")?.activityState).toBe("running");
  });

});
