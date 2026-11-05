import { describe, expect, test } from "bun:test";
import { getExecuteOutput } from "../models/tools/execute.js";
import type { ToolBlockData } from "../models/chat-state.js";

type Content = NonNullable<ToolBlockData["result"]>["content"];

function makeExecuteBlock(content: Content): ToolBlockData {
  return { id: "execute-test-id", name: "execute", args: { code: "image(x)" }, status: "done", result: { content } };
}

describe("Execute tool model helpers", () => {
  test("the output is the result's text blocks, without its images", () => {
    const inline = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
    const attachment = { type: "image" as const, attachmentId: "att_1", mimeType: "image/png", byteSize: 10, sha256: "abc" };
    const block = makeExecuteBlock([{ type: "text", text: "before" }, inline, attachment, { type: "text", text: "after" }]);

    expect(getExecuteOutput(block)).toBe("before\nafter");
  });
});
