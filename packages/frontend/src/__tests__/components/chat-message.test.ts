import { afterEach, describe, expect, mock, test } from "bun:test";
import { ChatMessage } from "../../components/chat-message.js";
import {
  AssistantMessage,
  buildMessages,
  type Message,
} from "../../models/message.js";
import type { AgentMessage, AssistantMessage as AgentAssistantMessage } from "../../models/agent-message.js";
import { ConversationsStore } from "../../models/stores/conversations-store.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";

function displayMessage(message: AgentMessage, sessionId = "sess-1"): ChatMessage {
  const domain = buildMessages([{
    entryId: "row-1",
    parentEntryId: "parent-row",
    renderKey: "row-1",
    message,
  }])[0];
  if (!domain) throw new Error("Expected displayable message");
  const element = new ChatMessage();
  element.message = domain;
  element.sessionId = sessionId;
  return element;
}

function setMessage(element: ChatMessage, message: Message) {
  element.message = message;
}

describe("ChatMessage", () => {
  afterEach(() => { restoreFetch(); });

  test("renders and expands a persisted compaction summary from initial hydration", async () => {
    const summary = "## Earlier work\n\n- Preserved after refresh";
    mockFetch(() => Response.json({
      items: [{
        id: "compaction-row",
        parentId: "assistant-row",
        message: {
          role: "compactionSummary",
          summary,
          tokensBefore: 120_000,
          timestamp: 640,
        },
      }],
      pageInfo: {
        hasPreviousPage: true,
        previousCursor: "before-compaction",
        hasNextPage: false,
        endCursor: "after-compaction",
      },
    }));
    const conversations = new ConversationsStore();

    expect(await conversations.syncMessages("persisted-session")).toBe(true);
    const [message] = conversations.get("persisted-session").messages;
    const element = new ChatMessage();
    element.message = message ?? null;

    const collapsed = element.render();
    expect(templateToString(collapsed)).toContain("Conversation summarized");
    expect(templateToString(collapsed)).not.toContain("Preserved after refresh");

    collectTemplateEventListeners(collapsed, "click")[0]?.call(element, new Event("click"));

    expect(templateToString(element.render())).toContain(summary);
  });

  test("renders user images above raw text and emits the image-viewer intent", () => {
    const element = displayMessage({
      role: "user",
      timestamp: 1,
      content: [
        { type: "text", text: "what do you see?" },
        {
          type: "image",
          attachmentId: "att_1",
          mimeType: "image/png",
          filename: "screen.png",
          byteSize: 123,
          width: 640,
          height: 480,
        },
      ],
    }, "sess-attachments");
    const dispatchEvent = mock((_event: Event) => true);
    Reflect.set(element, "dispatchEvent", dispatchEvent);

    const template = element.render();
    const output = templateToString(template);
    const attachmentsIndex = output.indexOf('data-role="user-message-attachments"');
    const bubbleIndex = output.indexOf('data-role="user-message-bubble"');

    expect(attachmentsIndex).toBeGreaterThan(-1);
    expect(attachmentsIndex).toBeLessThan(bubbleIndex);
    expect(output).toContain("what do you see?");
    expect(output).toContain("/api/sessions/sess-attachments/attachments/att_1");
    expect(output).toContain("aspect-ratio: 640 / 480");

    collectTemplateEventListeners(template, "click")[0]?.call(element, new Event("click"));
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "open-image-viewer" }));
  });

  test("renders assistant text and associated tool results in native content order", () => {
    const assistant: AgentAssistantMessage = {
      role: "assistant",
      timestamp: 2,
      content: [
        { type: "text", text: "First." },
        { type: "toolCall", id: "tc-1", name: "search", arguments: { query: "bar" } },
        { type: "text", text: "Second." },
      ],
    };
    const [message] = buildMessages([
      { entryId: "assistant", parentEntryId: "user", renderKey: "assistant", message: assistant },
      {
        entryId: "result",
        parentEntryId: "assistant",
        renderKey: "result",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "search",
          content: [{ type: "text", text: "found" }],
          isError: false,
          timestamp: 3,
        },
      },
    ]);
    if (!message) throw new Error("Expected assistant");
    const element = new ChatMessage();
    setMessage(element, message);

    const output = templateToString(element.render());
    const first = output.indexOf("First.");
    const tool = output.indexOf("search-tool-block");
    const second = output.indexOf("Second.");
    expect(first).toBeGreaterThan(-1);
    expect(tool).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(tool);
    expect(output).toContain("found");
  });

  test("waits for live execution before rendering a streaming tool call", () => {
    const raw: AgentAssistantMessage = {
      role: "assistant",
      timestamp: 20,
      content: [{
        type: "toolCall",
        id: "write-1",
        name: "write",
        arguments: { path: "file.ts", content: "partial" },
      }],
    };
    const element = new ChatMessage();
    element.message = new AssistantMessage(raw, null, null, "streaming-assistant-20", true);
    expect(templateToString(element.render())).not.toContain("write-tool-block");

    element.message = new AssistantMessage(
      raw,
      null,
      null,
      "streaming-assistant-20",
      true,
      new Map(),
      {
        "write-1": {
          id: "write-1",
          name: "write",
          args: { path: "file.ts", content: "complete" },
          status: "running",
        },
      },
    );
    const output = templateToString(element.render());
    expect(output).toContain("write-tool-block");
    expect(output).toContain("complete");
  });

  test("offers direct copy only for assistant messages", () => {
    const assistant = displayMessage({
      role: "assistant",
      content: [{ type: "text", text: "**raw markdown**" }],
      timestamp: 2,
    });
    const user = displayMessage({ role: "user", content: "raw text", timestamp: 1 });

    const assistantOutput = templateToString(assistant.render());
    expect(assistantOutput).toContain('data-role="desktop-copy-message"');
    expect(assistantOutput).toContain("Copy as Markdown");
    expect(assistantOutput).toContain('<rect width="14" height="14" x="8" y="8" rx="2"/>');
    expect(assistantOutput).toContain('d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"');
    expect(templateToString(user.render())).not.toContain('data-role="desktop-copy-message"');
  });
});
