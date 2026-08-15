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
  test("returns raw user text without rendering or normalization", () => {
    expect(domainMessage({
      role: "user",
      content: "  **raw**\ntext  ",
      timestamp: 1,
    }).toMarkdown()).toBe("  **raw**\ntext  ");

    expect(domainMessage({
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "image", attachmentId: "image-1", mimeType: "image/png", byteSize: 10 },
        { type: "text", text: "second" },
      ],
      timestamp: 2,
    }).toMarkdown()).toBe("first\nsecond");
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
    }).toMarkdown()).toBe("## Result\n\n- one\n- two");
  });

  test("does not offer Markdown for textless assistants", () => {
    expect(domainMessage({
      role: "assistant",
      content: [{ type: "thinking", thinking: "private reasoning" }],
      timestamp: 5,
    }).toMarkdown()).toBeNull();
  });
});
