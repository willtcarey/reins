import { test, expect } from "bun:test";
import { nodeCommand, nodeResult, deliveryPolicy } from "./contract.js";

test("delivery policy belongs to the operation, not to arbitrary caller requests", () => {
  expect(deliveryPolicy({ op: "session.prompt", sessionId: "s", clientId: "c", content: [], sourceSessionId: null })).toBe("submit-work");
  // A model change is ordered with the session's queued work, not applied immediately.
  expect(deliveryPolicy({ op: "session.setModel", sessionId: "s", provider: "p", modelId: "m" })).toBe("submit-work");
  expect(deliveryPolicy({ op: "session.abort", sessionId: "s" })).toBe("request-now");
  expect(deliveryPolicy({ op: "session.resumePending", sessionId: "s" })).toBe("request-now");
});

test("stored commands and results validate without transport framing", () => {
  expect(nodeCommand.parse({ op: "session.setModel", sessionId: "s", provider: "p", modelId: "m", thinkingLevel: "high" })).toMatchObject({ thinkingLevel: "high" });
  expect(nodeCommand.safeParse({ op: "session.setModel", sessionId: "s", provider: "", modelId: "m" }).success).toBe(false);
  expect(nodeResult.safeParse({ ok: true, value: { modelSet: true } }).success).toBe(true);
  expect(nodeCommand.parse({ op: "session.steer", sessionId: "s", clientId: "c", content: [{ type: "text", text: "hi" }], sourceSessionId: null }).op).toBe("session.steer");
  // The server always stores whether an input came from another session.
  expect(nodeCommand.safeParse({ op: "session.steer", sessionId: "s", clientId: "c", content: [] }).success).toBe(false);
  // Inputs carry attachment references only: inline bytes are rejected before they are stored.
  expect(nodeCommand.safeParse({ op: "session.prompt", sessionId: "s", clientId: "c", sourceSessionId: null, content: [{ type: "image", attachmentId: "a", mimeType: "image/png", byteSize: 4, data: "AAAA" }] }).success).toBe(false);
  expect(nodeCommand.parse({ op: "session.prompt", sessionId: "s", clientId: "c", sourceSessionId: "child", content: [{ type: "image", attachmentId: "a", mimeType: "image/png", byteSize: 4 }] })).toMatchObject({ sourceSessionId: "child", content: [{ attachmentId: "a" }] });
  expect(nodeCommand.safeParse({ op: "session.shell", sessionId: "s" }).success).toBe(false);
  expect(nodeResult.safeParse({ ok: false, error: { code: "unavailable", message: "offline", retryable: true } }).success).toBe(true);
  expect(nodeResult.safeParse({ ok: false, error: { code: "not_owner", message: "moved", retryable: false } }).success).toBe(true);
});
