import { describe, expect, test } from "bun:test";
import { buildMessages } from "../../models/message.js";
import type { AgentMessage } from "../../models/agent-message.js";

function domainMessage(message: AgentMessage) {
  const result = buildMessages([{
    entryId: "row-1",
    parentEntryId: null,
    renderKey: "row-1",
    message,
  }])[0];
  if (!result) throw new Error("Expected displayable message");
  return result;
}

describe("Message copy Markdown", () => {
  test("reports whether copyable Markdown exists without producing it", () => {
    expect(domainMessage({ role: "user", content: "", timestamp: 1 }).copyable).toBe(false);
    expect(domainMessage({ role: "user", content: "hello", timestamp: 2 }).copyable).toBe(true);
    expect(domainMessage({
      role: "assistant",
      content: [{ type: "thinking", thinking: "private reasoning" }],
      timestamp: 3,
    }).copyable).toBe(false);
    expect(domainMessage({
      role: "assistant",
      content: [{ type: "text", text: "result" }],
      timestamp: 4,
    }).copyable).toBe(true);
  });

  test("returns raw user text without rendering or normalization", () => {
    expect(domainMessage({
      role: "user",
      content: "  **raw**\ntext  ",
      timestamp: 1,
    }).copyMarkdown()).toBe("  **raw**\ntext  ");

    expect(domainMessage({
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "image", attachmentId: "image-1", mimeType: "image/png", byteSize: 10 },
        { type: "text", text: "second" },
      ],
      timestamp: 2,
    }).copyMarkdown()).toBe("first\nsecond");
  });

  test("joins assistant Markdown blocks and omits thinking and tools", () => {
    expect(domainMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "## Result" },
        { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "pwd" } },
        { type: "text", text: "- one\n- two" },
      ],
      timestamp: 3,
    }).copyMarkdown()).toBe("## Result\n\n- one\n- two");
  });

  test("does not offer Markdown for textless assistants", () => {
    expect(domainMessage({
      role: "assistant",
      content: [{ type: "thinking", thinking: "private reasoning" }],
      timestamp: 5,
    }).copyMarkdown()).toBeNull();
  });
});
