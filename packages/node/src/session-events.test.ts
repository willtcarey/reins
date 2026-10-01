import { expect, test } from "bun:test";
import type { AgentRuntimeEvent, RuntimeContentBlock, RuntimeMessage } from "@reins/node-protocol";
import { sendableEvent } from "./session-events.js";

const reference = { type: "image" as const, attachmentId: "att_1", mimeType: "image/png", byteSize: 3, sha256: "a".repeat(64) };
const inline = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
const unavailable = { type: "text" as const, text: "[Image attachment unavailable]" };
const toolResult = (block: RuntimeContentBlock): RuntimeMessage => ({ role: "toolResult", toolCallId: "t", toolName: "read", isError: false, timestamp: 1, content: [{ type: "text", text: "x" }, block] });

test("a session event is serialized once, with every image that is not an attachment reference replaced by a placeholder", () => {
  const cases: Array<[AgentRuntimeEvent, unknown]> = [
    [{ type: "message_end", streamId: "1", message: toolResult(reference) }, { type: "message_end", streamId: "1", message: toolResult(reference) }],
    [{ type: "message_end", streamId: "1", message: toolResult(inline) }, { type: "message_end", streamId: "1", message: toolResult(unavailable) }],
    // A reference that still carries bytes is not a reference.
    [{ type: "entry_added", entry: { id: "e", parentId: null, seq: 1, message: toolResult({ ...reference, data: "AAAA" }) } },
      { type: "entry_added", entry: { id: "e", parentId: null, seq: 1, message: toolResult(unavailable) } }],
    [{ type: "agent_end", messages: [toolResult(inline)] }, { type: "agent_end", messages: [toolResult(unavailable)] }],
    [{ type: "tool_execution_update", toolCallId: "t", toolName: "read", args: {}, partialResult: { content: [inline, reference] } },
      { type: "tool_execution_update", toolCallId: "t", toolName: "read", args: {}, partialResult: { content: [unavailable, reference] } }],
    [{ type: "tool_execution_end", toolCallId: "t", toolName: "read", isError: false, result: { content: [inline] } },
      { type: "tool_execution_end", toolCallId: "t", toolName: "read", isError: false, result: { content: [unavailable] } }],
    [{ type: "message_update", streamId: "1", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } },
      { type: "message_update", streamId: "1", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } }],
  ];
  for (const [event, sent] of cases) expect(JSON.parse(sendableEvent(event))).toEqual(sent);
});
