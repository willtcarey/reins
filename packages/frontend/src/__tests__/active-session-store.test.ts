import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentMessage } from "../models/chat-state.js";
import { ActiveSessionStore } from "../models/stores/active-session-store.js";
import { ConversationsStore } from "../models/stores/conversations-store.js";
import { SessionCache } from "../models/stores/session-cache.js";
import { StubClient } from "./helpers/stub-client.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";
import {
  applyStreamingAssistant,
  completedToolTurn,
  messagePage,
  setPersistedMessages,
} from "./helpers/conversations.js";

type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;
type AssertTrue<T extends true> = T;
type ConversationMessages = ActiveSessionStore["conversation"]["messages"];
type _ConversationMessagesElementIsTyped = AssertFalse<IsAny<ConversationMessages[number]>>;
type _ConversationMessagesMatchAgentMessages = AssertTrue<ConversationMessages extends AgentMessage[] ? true : false>;

function jsonResponse(data: unknown) {
  const body = Array.isArray(data) ? messagePage(data) : data;
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
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

  test("does not expose optimistic user message mutation", () => {
    const store = new ActiveSessionStore("sess-1", null, new SessionCache());

    expect(Reflect.get(store, "addOptimisticUserMessage")).toBeUndefined();
  });

  test("message refresh updates notify through the conversation subscription only", async () => {
    const sessionCache = new SessionCache();
    const conversationsStore = new ConversationsStore();
    const store = new ActiveSessionStore("sess-1", null, sessionCache, conversationsStore);
    sessionCache.set("sess-1", makeSessionData());
    const responses: AgentMessage[][] = [[], twoMessages];
    mockFetch((url) => {
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(responses.shift() ?? []);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();

    let notifyCount = 0;
    store.subscribe(() => { notifyCount += 1; });

    await conversationsStore.syncMessages("sess-1");

    expect(notifyCount).toBe(1);
    expect(store.conversation.messages).toEqual(twoMessages);
  });
});

describe("ActiveSessionStore command helpers", () => {
  test("prompt, steer, and abort target the active session", () => {
    const client = new StubClient();
    client.prompt = mock(() => {});
    client.steer = mock(() => {});
    client.abort = mock(() => {});

    const store = new ActiveSessionStore("sess-1", client);

    const promptEntry = store.prompt([{ type: "text", text: "hello" }]);
    const steerEntry = store.steer([{ type: "text", text: "keep going" }]);
    expect(promptEntry?.localId).toBe("live-1");
    expect(steerEntry?.localId).toBe("live-2");
    expect(store.abort()).toBe(true);

    expect(client.prompt).toHaveBeenCalledWith("sess-1", [{ type: "text", text: "hello" }]);
    expect(client.steer).toHaveBeenCalledWith("sess-1", [{ type: "text", text: "keep going" }]);
    expect(client.abort).toHaveBeenCalledWith("sess-1");
    expect(store.conversation.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: expect.any(Number) },
      { role: "user", content: [{ type: "text", text: "keep going" }], timestamp: expect.any(Number) },
    ]);
    expect(store.conversation.entries.every((entry) => entry.id === null)).toBe(true);
    expect(new Set(store.conversation.entries.map((entry) => entry.id ?? entry.localId)).size).toBe(2);
  });

  test("prompt optimistically marks cached activityState running", () => {
    const client = new StubClient();
    client.prompt = mock(() => {});
    const sessionCache = new SessionCache();
    sessionCache.set("sess-1", makeSessionData({ activityState: null }));
    const store = new ActiveSessionStore("sess-1", client, sessionCache);

    expect(store.prompt([{ type: "text", text: "hello" }])).not.toBeNull();

    expect(sessionCache.get("sess-1")?.activityState).toBe("running");
  });

});

const twoMessages: AgentMessage[] = [
  { role: "user", content: "hello", timestamp: 1000 },
  { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2000 },
];

describe("ActiveSessionStore session loading contract", () => {
  afterEach(() => { restoreFetch(); });

  test("initialize reads cached metadata immediately while refreshing server state", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);
    const calls: string[] = [];
    sessionCache.set("sess-1", makeSessionData({ messageCount: 2 }));

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1") return jsonResponse(makeSessionData({ messageCount: 2 }));
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(twoMessages);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();

    expect(calls).toEqual(["/api/sessions/sess-1", "/api/sessions/sess-1/messages"]);
    expect(store.projectId).toBe(42);
    expect(store.sessionData.messageCount).toBe(2);
    expect(store.conversation.messages).toEqual(twoMessages);
  });

  test("initialize fetches metadata when SessionCache has no detail", async () => {
    const store = new ActiveSessionStore("sess-1", null, new SessionCache());
    const calls: string[] = [];

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1") return jsonResponse(makeSessionData({ messageCount: 2 }));
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(twoMessages);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();

    expect(calls).toEqual(["/api/sessions/sess-1", "/api/sessions/sess-1/messages"]);
    expect(store.projectId).toBe(42);
    expect(store.sessionData.messageCount).toBe(2);
    expect(store.conversation.messages).toEqual(twoMessages);
  });

  test("initialize leaves metadata blank when detail fetch fails", async () => {
    const store = new ActiveSessionStore("sess-1", null, new SessionCache());
    const calls: string[] = [];

    mockFetch((url) => {
      calls.push(url);
      if (url === "/api/sessions/sess-1") return new Response("not found", { status: 404 });
      if (url === "/api/sessions/sess-1/messages") return jsonResponse(twoMessages);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();

    expect(calls).toEqual(["/api/sessions/sess-1", "/api/sessions/sess-1/messages"]);
    expect(store.projectId).toBeNull();
    expect(store.sessionData).toEqual({
      ...makeSessionData({ messageCount: 0, projectId: 0, runtimeType: undefined }),
      id: "sess-1",
      runtimeType: undefined,
      state: { model: null, thinkingLevel: "high" },
    });
    expect(store.conversation.messages).toEqual(twoMessages);
  });

  test("subscribes to SessionCache updates for the active session", async () => {
    const sessionCache = new SessionCache();
    const store = new ActiveSessionStore("sess-1", null, sessionCache);

    mockFetch((url) => {
      if (url === "/api/sessions/sess-1") return new Response("not found", { status: 404 });
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
      if (url === "/api/sessions/sess-1") return new Response("not found", { status: 404 });
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

    expect(store.conversation.messages).toEqual(twoMessages);
  });

  test("shared conversation queries may complete after the active facade is disposed", async () => {
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

    expect(conversationsStore.get("sess-1").messages).toEqual(twoMessages);
  });

  test("initial cached terminal metadata clears only stale compacting state", async () => {
    const sessionCache = new SessionCache();
    const conversationsStore = new ConversationsStore();
    sessionCache.set("sess-1", makeSessionData({ activityState: "finished" }));
    applyStreamingAssistant(conversationsStore, "sess-1", [{ id: "tool-1", done: true }], 2000);
    const optimistic = conversationsStore.addOptimisticUserMessage(
      "sess-1",
      [{ type: "text", text: "follow-up" }],
      3000,
    );
    if (!optimistic) throw new Error("Expected optimistic entry");
    conversationsStore.applyEvent("sess-1", { type: "compaction_start", reason: "threshold" });
    const store = new ActiveSessionStore("sess-1", null, sessionCache, conversationsStore);

    mockFetch((url, init) => {
      if (url === "/api/sessions/sess-1") return jsonResponse(makeSessionData({ activityState: "finished" }));
      if (url === "/api/sessions/sess-1/messages") return new Response("unavailable", { status: 503 });
      if (url === "/api/sessions/sess-1/activity" && init?.method === "PATCH") return jsonResponse({ ok: true });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();

    expect(store.conversation.isCompacting).toBe(false);
    expect(store.conversation.streamingAssistants).toHaveLength(1);
    expect(store.conversation.entries).toContainEqual(optimistic);
  });

  test("running to finished metadata clears stale compaction without discarding live work", async () => {
    const sessionCache = new SessionCache();
    const conversationsStore = new ConversationsStore();
    sessionCache.set("sess-1", makeSessionData({ activityState: "running" }));
    const store = new ActiveSessionStore("sess-1", null, sessionCache, conversationsStore);
    await callPrivate(store, "handleSessionCacheUpdate");

    applyStreamingAssistant(conversationsStore, "sess-1", ["still live", { id: "tool-1" }], 2000);
    const optimistic = conversationsStore.addOptimisticUserMessage(
      "sess-1",
      [{ type: "text", text: "queued steer" }],
      3000,
    );
    if (!optimistic) throw new Error("Expected optimistic entry");
    conversationsStore.applyEvent("sess-1", { type: "compaction_start", reason: "threshold" });

    mockFetch((url, init) => {
      if (url === "/api/sessions/sess-1/messages") return new Response("not persisted yet", { status: 503 });
      if (url === "/api/sessions/sess-1/activity" && init?.method === "PATCH") return jsonResponse({ ok: true });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    sessionCache.set("sess-1", makeSessionData({ activityState: "finished", messageCount: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.conversation.isCompacting).toBe(false);
    expect(store.conversation.streamingAssistants).toHaveLength(1);
    expect(store.conversation.entries).toContainEqual(optimistic);
  });

  test("running metadata does not clear active compaction", async () => {
    const sessionCache = new SessionCache();
    const conversationsStore = new ConversationsStore();
    const store = new ActiveSessionStore("sess-1", null, sessionCache, conversationsStore);
    conversationsStore.applyEvent("sess-1", { type: "compaction_start", reason: "threshold" });

    sessionCache.set("sess-1", makeSessionData({ activityState: "running" }));
    await callPrivate(store, "handleSessionCacheUpdate");

    expect(store.conversation.isCompacting).toBe(true);
  });

  test("terminal reconciliation remains scoped to the active route", async () => {
    const sessionCache = new SessionCache();
    const conversationsStore = new ConversationsStore();
    const store = new ActiveSessionStore("sess-1", null, sessionCache, conversationsStore);
    conversationsStore.applyEvent("sess-2", { type: "compaction_start", reason: "threshold" });

    sessionCache.set("sess-2", makeSessionData({ activityState: "finished" }));
    await Promise.resolve();

    expect(store.sessionId).toBe("sess-1");
    expect(conversationsStore.get("sess-2").isCompacting).toBe(true);
  });

  test("finished metadata cannot discard agent_end output when persistence sync fails", async () => {
    const sessionCache = new SessionCache();
    const conversationsStore = new ConversationsStore();
    sessionCache.set("sess-1", makeSessionData({ activityState: "running" }));
    const store = new ActiveSessionStore("sess-1", null, sessionCache, conversationsStore);
    const finalAssistant: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Final answer" }],
      timestamp: 2000,
    };

    applyStreamingAssistant(conversationsStore, "sess-1", ["partial"], 2000);
    conversationsStore.applyEvent("sess-1", {
      type: "agent_end",
      messages: [{ role: "user", content: "runtime copy", timestamp: 1000 }, finalAssistant],
    });
    expect(store.conversation.messages).toEqual([finalAssistant]);
    expect(store.conversation.streamingAssistants).toEqual([]);

    mockFetch((url, init) => {
      if (url === "/api/sessions/sess-1/messages") return new Response("unavailable", { status: 503 });
      if (url === "/api/sessions/sess-1/activity" && init?.method === "PATCH") return jsonResponse({ ok: true });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    sessionCache.set("sess-1", makeSessionData({ activityState: "finished", messageCount: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.conversation.messages).toEqual([finalAssistant]);
    expect(store.conversation.entries[0]?.id).toBeNull();
  });

  test("finished metadata leaves only the canonical turn when the running transition was missed", async () => {
    const sessionCache = new SessionCache();
    const conversationsStore = new ConversationsStore();
    const store = new ActiveSessionStore("sess-1", null, sessionCache, conversationsStore);

    const tool = {
      id: "tool-1",
      name: "read",
      arguments: { path: "README.md" },
      result: "contents",
    };
    applyStreamingAssistant(conversationsStore, "sess-1", [tool], 1000);
    const finalMessages = completedToolTurn([tool], "Done", 1000);
    setPersistedMessages(conversationsStore, "sess-1", finalMessages);

    expect(store.conversation.messages.at(-1)).toEqual(finalMessages.at(-1));
    expect(store.conversation.streamingAssistants).toEqual([]);

    mockFetch((url, init) => {
      if (url === "/api/sessions/sess-1/activity" && init?.method === "PATCH") {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // This client joined after the run began, so its first authoritative
    // activity state is already terminal rather than a running → finished transition.
    sessionCache.set("sess-1", makeSessionData({ activityState: "finished", messageCount: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.conversation.messages).toEqual(finalMessages);
    expect(store.conversation.streamingAssistants).toEqual([]);
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
    expect(store.conversation.messages).toHaveLength(3);
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

  test("session cache update marks finished activity viewed", async () => {
    const sessionCache = new SessionCache();
    sessionCache.set("sess-1", makeSessionData({ activityState: "running" }));
    const store = new ActiveSessionStore("sess-1", null, sessionCache);

    const calls: Array<{ url: string; method: string }> = [];
    mockFetch((url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/sessions/sess-1/messages") return jsonResponse([]);
      if (url === "/api/sessions/sess-1/activity" && init?.method === "PATCH") return jsonResponse({ ok: true });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await callPrivate(store, "handleSessionCacheUpdate");
    sessionCache.set("sess-1", makeSessionData({ activityState: "finished" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sessionCache.get("sess-1")?.activityState).toBeNull();
    expect(calls).toContainEqual({ url: "/api/sessions/sess-1/activity", method: "PATCH" });
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
      if (url === "/api/sessions/sess-1") return jsonResponse(makeSessionData({ activityState: "running" }));
      if (url === "/api/sessions/sess-1/messages") return jsonResponse([]);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await store.initialize();
    await store.markViewed();

    expect(calls).toEqual(["/api/sessions/sess-1", "/api/sessions/sess-1/messages"]);
    expect(sessionCache.get("sess-1")?.activityState).toBe("running");
  });

});
