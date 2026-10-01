import { afterEach, describe, expect, jest, test } from "bun:test";
import { ConversationsStore } from "../../../models/stores/conversations-store.js";
import type { AgentMessage } from "../../../models/agent-message.js";
import { conversationPage } from "../../helpers/conversations.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

const content = (text: string) => [{ type: "text" as const, text }];
const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: content(text), timestamp });
const assistant = (text: string, timestamp: number): AgentMessage => ({ role: "assistant", content: content(text), timestamp });
const entry = (id: string, seq: number, message: AgentMessage, clientId?: string): import("../../../models/stores/conversations-store.js").ConversationEntry => ({
  id, parentId: seq === 1 ? null : `entry-${seq - 1}`, seq, ...(clientId ? { clientId } : {}), message,
});
const raw = (store: ConversationsStore, sessionId = "session"): AgentMessage[] => (
  store.get(sessionId).messages.map(({ raw: message }) => message)
);

describe("ConversationsStore canonical reconciliation", () => {
  afterEach(restoreFetch);

  test("coalesces synchronization and follows canonical forward cursors", async () => {
    const store = new ConversationsStore();
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      if (url.endsWith("/messages")) return Response.json(conversationPage(
        [entry("entry-1", 1, user("one", 1))],
        { hasNextPage: true, endCursor: "next" },
      ));
      return Response.json(conversationPage([entry("entry-2", 2, assistant("two", 2))]));
    });

    const first = store.syncMessages("session");
    const second = store.syncMessages("session");
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(calls).toEqual(["/api/sessions/session/messages", "/api/sessions/session/messages?after=next"]);
    expect(raw(store)).toEqual([user("one", 1), assistant("two", 2)]);
  });

  test("upserts the same canonical envelope idempotently from event and page in either order", () => {
    const canonical = entry("entry-1", 1, assistant("done", 2));
    for (const eventFirst of [true, false]) {
      const store = new ConversationsStore();
      if (eventFirst) store.applyEvent("session", { type: "entry_added", entry: canonical });
      store.mergeMessages("session", conversationPage([canonical]));
      if (!eventFirst) store.applyEvent("session", { type: "entry_added", entry: canonical });
      expect(raw(store)).toEqual([canonical.message]);
      expect(store.get("session").messages[0]).toMatchObject({ entryId: "entry-1", renderKey: "entry-1" });
    }
  });

  test("reconciles optimistic submissions only by client identity and preserves render continuity", () => {
    const store = new ConversationsStore();
    const optimistic = store.addOptimisticUserMessage("session", content("same"), "client-1", 10)!;
    store.addOptimisticUserMessage("session", content("same"), "client-2", 11);

    const second = entry("entry-2", 2, user("same", 20), "client-2");
    store.applyEvent("session", { type: "entry_added", entry: second });
    expect(store.get("session").messages.map(({ renderKey }) => renderKey)).toEqual([
      "submission-client-2", "submission-client-1",
    ]);

    const first = entry("entry-1", 1, user("same", 21), "client-1");
    store.mergeMessages("session", conversationPage([first, second]));
    expect(store.get("session").messages.map(({ renderKey }) => renderKey)).toEqual([
      optimistic.localId, "submission-client-2",
    ]);
    expect(store.get("session").messages.map(({ entryId }) => entryId)).toEqual(["entry-1", "entry-2"]);
  });

  test("stale pages cannot consume a different pending submission", () => {
    const store = new ConversationsStore();
    const stale = entry("entry-old", 1, user("same", 1), "old-client");
    store.mergeMessages("session", conversationPage([stale]));
    store.addOptimisticUserMessage("session", content("same"), "new-client", 2);
    store.mergeMessages("session", conversationPage([stale]));
    expect(store.get("session").messages.map(({ renderKey }) => renderKey)).toEqual([
      "submission-old-client", "submission-new-client",
    ]);
  });

  test("message_end upgrades a streaming overlay and canonical identity removes exactly that overlay", () => {
    const store = new ConversationsStore();
    store.applyEvent("session", { type: "message_start", streamId: "stream-1", message: assistant("working", 10) });
    store.applyEvent("session", { type: "message_start", streamId: "stream-2", message: assistant("other", 10) });
    store.applyEvent("session", { type: "message_end", streamId: "stream-1", entryId: "entry-1", message: assistant("done", 10) });
    store.applyEvent("session", { type: "entry_added", entry: entry("entry-1", 1, assistant("done", 10)) });

    expect(raw(store)).toEqual([assistant("done", 10)]);
    expect(store.get("session").streamingMessages).toHaveLength(1);
    expect(store.get("session").streamingMessages[0]?.toMarkdown()).toBe("other");
  });

  test("a session event sequence jump (missed events, a reconnect that lost some, a node restart) holds streaming deltas until the next keyframe", () => {
    const store = new ConversationsStore();
    const streamed = () => store.get("session").streamingMessages.map((message) => message.toMarkdown());
    const delta = (seq: number, text: string) => store.applyEvent("session", { type: "message_update", streamId: "s", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } }, seq);
    store.applyEvent("session", { type: "message_start", streamId: "s", message: assistant("", 10) }, 1);
    delta(2, "Hel");
    expect(streamed()).toEqual(["Hel"]);

    delta(5, "lost");
    delta(6, "lost");
    expect(streamed()).toEqual(["Hel"]);
    store.applyEvent("session", { type: "message_update", streamId: "s", message: assistant("Hello", 10), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } }, 7);
    delta(8, "!");
    expect(streamed()).toEqual(["Hello!"]);

    // A restarted node counts from 1 again.
    delta(1, "?");
    expect(streamed()).toEqual(["Hello!"]);
  });

  test("shows only durable compaction summaries and never promotes canonical-runtime agent_end transcripts", () => {
    const store = new ConversationsStore();
    store.applyEvent("session", { type: "compaction_start" });
    store.applyEvent("session", { type: "compaction_end", result: { summary: "synthetic" } });
    store.applyEvent("session", { type: "agent_end", messages: [assistant("fallback", 2)] });
    expect(raw(store)).toEqual([]);

    const summary: AgentMessage = { role: "compactionSummary", summary: "canonical", timestamp: 3 };
    store.applyEvent("session", { type: "entry_added", entry: entry("summary-1", 1, summary) });
    expect(raw(store)).toEqual([summary]);
    expect(store.get("session").isCompacting).toBe(false);
  });
});

const update = (delta: string) => ({
  type: "message_update" as const,
  streamId: "stream-1",
  assistantMessageEvent: { type: "text_delta" as const, contentIndex: 0, delta },
});

/** Replace a global for one test; returns the restore function. */
function stubGlobal(name: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  };
}

describe("ConversationsStore streaming notifications", () => {
  function frameStore() {
    const frames: { callback: () => void; cancelled: boolean }[] = [];
    const store = new ConversationsStore({
      scheduleFrame: (callback) => {
        const frame = { callback, cancelled: false };
        frames.push(frame);
        return () => { frame.cancelled = true; };
      },
    });
    const runFrames = () => {
      for (const frame of frames.splice(0)) if (!frame.cancelled) frame.callback();
    };
    return { store, frames, runFrames };
  }

  test("applies streaming updates immediately but notifies viewers once per frame", () => {
    const { store, frames, runFrames } = frameStore();
    let notifications = 0;
    store.subscribe("session", () => { notifications += 1; });

    store.applyEvent("session", { type: "message_start", streamId: "stream-1", message: assistant("", 10) });
    expect(notifications).toBe(1);
    store.applyEvent("session", update("a"));
    store.applyEvent("session", update("b"));
    store.applyEvent("session", update("c"));
    expect(store.get("session").streamingMessages[0]?.toMarkdown()).toBe("abc");
    expect(notifications).toBe(1);
    expect(frames).toHaveLength(1);

    runFrames();
    expect(notifications).toBe(2);

    store.applyEvent("session", update("d"));
    store.flushNotifications();
    expect(notifications).toBe(3);

    // Lifecycle boundaries notify synchronously and absorb any pending frame.
    store.applyEvent("session", update("e"));
    store.applyEvent("session", { type: "message_end", streamId: "stream-1", entryId: "entry-1", message: assistant("abcde", 10) });
    expect(notifications).toBe(4);
    runFrames();
    expect(notifications).toBe(4);
  });

  test("notifies on the next animation frame, or after a timeout when frames do not run (hidden tabs)", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const restore = [
      stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; }),
      stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); }),
    ];
    jest.useFakeTimers();
    try {
      const store = new ConversationsStore();
      let notifications = 0;
      store.subscribe("session", () => { notifications += 1; });
      store.applyEvent("session", { type: "message_start", streamId: "stream-1", message: assistant("", 10) });
      expect(notifications).toBe(1);

      store.applyEvent("session", update("a"));
      expect(frames.size).toBe(1);
      for (const callback of frames.values()) callback(0);
      expect(notifications).toBe(2);
      jest.advanceTimersByTime(2000);
      expect(notifications).toBe(2);

      store.applyEvent("session", update("b"));
      jest.advanceTimersByTime(999);
      expect(notifications).toBe(2);
      jest.advanceTimersByTime(1);
      expect(notifications).toBe(3);
      expect(frames.size).toBe(0);
      expect(store.get("session").streamingMessages[0]?.toMarkdown()).toBe("ab");
    } finally {
      jest.useRealTimers();
      for (const undo of restore) undo();
    }
  });

  test("keeps unviewed sessions current without scheduling renders", () => {
    const { store, frames } = frameStore();
    store.applyEvent("session", { type: "message_start", streamId: "stream-1", message: assistant("", 10) });
    store.applyEvent("session", update("hidden"));
    expect(frames).toHaveLength(0);
    expect(store.get("session").streamingMessages[0]?.toMarkdown()).toBe("hidden");
  });

  test("streaming updates preserve transcript message identity", () => {
    const store = new ConversationsStore();
    store.mergeMessages("session", conversationPage([entry("entry-1", 1, user("hi", 1)), entry("entry-2", 2, assistant("hello", 2))]));
    store.applyEvent("session", { type: "message_start", streamId: "stream-1", message: assistant("", 10) });
    const before = store.get("session");

    store.applyEvent("session", update("streaming"));
    const after = store.get("session");
    expect(after.messages).toBe(before.messages);
    expect(after.streamingMessages).not.toBe(before.streamingMessages);
    expect(store.get("session")).toBe(after);

    store.applyEvent("session", { type: "entry_added", entry: entry("entry-3", 3, user("next", 3)) });
    expect(raw(store)).toEqual([user("hi", 1), assistant("hello", 2), user("next", 3)]);
  });
});
