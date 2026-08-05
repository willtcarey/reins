import { describe, expect, test } from "bun:test";
import { messageMarkdown } from "../../models/message-markdown.js";

describe("messageMarkdown", () => {
  test("returns raw user text without Markdown rendering or normalization", () => {
    expect(messageMarkdown({
      role: "user",
      content: "  **raw**\ntext  ",
      timestamp: 1,
    })).toBe("  **raw**\ntext  ");

    expect(messageMarkdown({
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "image", attachmentId: "image-1", mimeType: "image/png", byteSize: 10 },
        { type: "text", text: "second" },
      ],
      timestamp: 2,
    })).toBe("first\nsecond");
  });

  test("joins assistant Markdown text blocks with blank lines and omits thinking and tools", () => {
    expect(messageMarkdown({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "## Result" },
        { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "pwd" } },
        { type: "text", text: "- one\n- two" },
      ],
      timestamp: 3,
    })).toBe("## Result\n\n- one\n- two");
  });

  test("does not offer Markdown for transcript-only message types or textless assistants", () => {
    expect(messageMarkdown({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text: "secret tool output" }],
      isError: false,
      timestamp: 4,
    })).toBeNull();
    expect(messageMarkdown({
      role: "assistant",
      content: [{ type: "thinking", thinking: "private reasoning" }],
      timestamp: 5,
    })).toBeNull();
  });
});
