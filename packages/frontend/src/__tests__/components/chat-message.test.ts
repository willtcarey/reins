import { describe, expect, mock, test } from "bun:test";
import { ChatMessage } from "../../components/chat-message.js";
import {
  AssistantMessage,
  buildMessages,
  type Message,
} from "../../models/message.js";
import type { AgentMessage, AssistantMessage as AgentAssistantMessage } from "../../models/agent-message.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";

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

  test("owns desktop copy confirmation without panel-level message keys", async () => {
    const element = displayMessage({
      role: "assistant",
      content: [{ type: "text", text: "**raw markdown**" }],
      timestamp: 2,
    });
    const copyMessage = mock(async (_text: string) => true);
    Reflect.set(element, "copyMessage", copyMessage);

    const template = element.render();
    expect(templateToString(template)).toContain('data-role="desktop-copy-message"');
    const desktopCopy = collectTemplateEventListeners(template, "click")[0];
    await desktopCopy?.call(element, new Event("click"));

    expect(copyMessage).toHaveBeenCalledWith("**raw markdown**");
    expect(templateToString(element.render())).toContain("title=Copied");
    Reflect.get(element, "clearCopyFeedbackTimer").call(element);
  });

  test("opens raw Markdown through context-menu and keyboard paths", () => {
    const element = displayMessage({ role: "user", content: "raw user text", timestamp: 1 });
    const openContext = mock((_text: string, _x: number, _y: number) => undefined);
    Object.defineProperty(element, "actionMenu", {
      configurable: true,
      value: { openSheet: async () => undefined, openContext, close() {} },
    });
    const template = element.render();
    const [contextMenu] = collectTemplateEventListeners(template, "contextmenu");
    const [keyboardMenu] = collectTemplateEventListeners(template, "keydown");
    const preventDefault = mock(() => undefined);

    // @ts-expect-error Only fields read by the component are required.
    contextMenu?.call(element, { clientX: 80, clientY: 120, preventDefault });
    // @ts-expect-error Only fields read by the component are required.
    keyboardMenu?.call(element, { key: "ContextMenu", shiftKey: false, preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(openContext).toHaveBeenNthCalledWith(1, "raw user text", 80, 120);
    expect(openContext).toHaveBeenNthCalledWith(2, "raw user text", 0, 0);
  });

  test("does not show copied feedback when the clipboard operation fails", async () => {
    const element = displayMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      timestamp: 2,
    });
    Reflect.set(element, "copyMessage", mock(async () => false));

    await collectTemplateEventListeners(element.render(), "click")[0]?.call(element, new Event("click"));

    expect(templateToString(element.render())).toContain("title=Copy as Markdown");
    expect(templateToString(element.render())).not.toContain("title=Copied");
  });
});
