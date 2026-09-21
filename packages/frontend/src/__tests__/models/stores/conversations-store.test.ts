import { afterEach, describe, expect, test } from "bun:test";
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
