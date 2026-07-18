import { describe, expect, test } from "bun:test";
import { ChatPanel } from "../components/chat-panel.js";
import { ActiveSessionStore } from "../models/stores/active-session-store.js";
import { ConversationsStore } from "../models/stores/conversations-store.js";
import type { AgentMessage } from "../models/chat-state.js";
import { setPersistedMessages } from "./helpers/conversations.js";
import { templateToString } from "./helpers/lit-template.js";

function isDirectiveResult(value: unknown): value is { values: unknown[] } {
  return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "values"));
}

function renderFirstMessage(el: ChatPanel): string {
  const messageDirective = el.render().values.find(isDirectiveResult);
  const entries = messageDirective?.values[0];
  const renderEntry = messageDirective?.values[2];
  if (!Array.isArray(entries) || typeof renderEntry !== "function") {
    throw new Error("Expected rendered conversation entries");
  }
  return templateToString(renderEntry(entries[0]));
}

function panelWithConversation(options: {
  messages?: AgentMessage[];
  compacting?: boolean;
  streaming?: boolean;
} = {}) {
  const el = new ChatPanel();
  const cache = new ConversationsStore();
  const store = new ActiveSessionStore("sess-1", null, undefined, cache);
  el.store = store;

  if (options.messages) setPersistedMessages(cache, "sess-1", options.messages);
  if (options.streaming) cache.applyEvent("sess-1", { type: "agent_start" });
  if (options.compacting) cache.applyEvent("sess-1", { type: "compaction_start" });

  return el;
}

describe("ChatPanel assistant render order", () => {
  test("keeps tool calls in content order relative to text blocks", () => {
    const el = panelWithConversation({
      messages: [{
        role: "assistant",
        timestamp: 1,
        content: [
          { type: "toolCall", id: "tc1", name: "search", arguments: { query: "foo" } },
          { type: "text", text: "Done." },
        ],
      }],
    });

    const output = renderFirstMessage(el);

    const toolIdx = output.indexOf("search-tool-block");
    const textIdx = output.indexOf(".text=Done.");

    expect(toolIdx).toBeGreaterThan(-1);
    expect(textIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeLessThan(textIdx);
  });

  test("preserves interleaved text → tool → text ordering", () => {
    const el = panelWithConversation({
      messages: [{
        role: "assistant",
        timestamp: 2,
        content: [
          { type: "text", text: "First." },
          { type: "toolCall", id: "tc2", name: "search", arguments: { query: "bar" } },
          { type: "text", text: "Second." },
        ],
      }],
    });

    const output = renderFirstMessage(el);

    const firstTextIdx = output.indexOf(".text=First.");
    const toolIdx = output.indexOf("search-tool-block");
    const secondTextIdx = output.indexOf(".text=Second.");

    expect(firstTextIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeGreaterThan(-1);
    expect(secondTextIdx).toBeGreaterThan(-1);

    expect(firstTextIdx).toBeLessThan(toolIdx);
    expect(toolIdx).toBeLessThan(secondTextIdx);
  });
});

describe("ChatPanel compaction rendering", () => {
  test("shows summarizing status even when the session is not streaming", () => {
    const el = panelWithConversation({ compacting: true });

    const output = templateToString(el.render());

    expect(output).toContain("Summarizing conversation…");
    expect(output).toContain("text-sm text-amber-500/80");
    expect(output).not.toContain("Thinking...");
    expect(output).not.toContain("Send a message to start a conversation");
  });

  test("shows the same summarizing status instead of thinking while streaming", () => {
    const el = panelWithConversation({ compacting: true, streaming: true });

    const output = templateToString(el.render());

    expect(output).toContain("Summarizing conversation…");
    expect(output).toContain("text-sm text-amber-500/80");
    expect(output).not.toContain("Thinking...");
  });
});
