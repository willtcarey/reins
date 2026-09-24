import { test, expect } from "bun:test";
import { contractVersion, nodeCommand, nodeResult, nodeEvent, deliveryPolicy } from "./contract.js";

test("delivery policy belongs to the operation, not to arbitrary caller requests", () => {
  expect(deliveryPolicy({ op: "session.open", sessionId: "s", sourceId: 1, mode: "create" })).toBe("submit-work");
  expect(deliveryPolicy({ op: "session.open", sessionId: "s", sourceId: 1, mode: "reopen" })).toBe("request-now");
  expect(deliveryPolicy({ op: "session.prompt", sessionId: "s", clientId: "c", content: [] })).toBe("request-now");
  expect(deliveryPolicy({ op: "session.abort", sessionId: "s" })).toBe("request-now");
});

test("semantic contract validates commands, results and observations without transport framing", () => {
  expect(contractVersion).toBe(1);
  expect(nodeCommand.parse({ op: "session.steer", sessionId: "s", clientId: "c", content: [{ type: "text", text: "hi" }] }).op).toBe("session.steer");
  expect(nodeCommand.safeParse({ op: "session.shell", sessionId: "s" }).success).toBe(false);
  expect(nodeResult.safeParse({ ok: false, error: { code: "unavailable", message: "offline", retryable: true } }).success).toBe(true);
  expect(nodeEvent.safeParse({ sessionId: "s", kind: "canonical_entry", payload: { id: "entry" } }).success).toBe(true);
});
