import { test, expect } from "bun:test";
import { contractVersion, nodeCommand, nodeResult, nodeEvent, deliveryPolicy } from "./contract.js";

test("delivery policy belongs to the operation, not to arbitrary caller requests", () => {
  const configuration = { model: { provider: "p", modelId: "m" }, thinkingLevel: null, task: null };
  expect(deliveryPolicy({ op: "session.provision", sessionId: "s", sourceId: 1, configuration })).toBe("submit-work");
  expect(nodeCommand.safeParse({ op: "session.provision", sessionId: "s", sourceId: 1 }).success).toBe(false);
  expect(nodeCommand.safeParse({ op: "session.provision", sessionId: "s", sourceId: 1, mode: "reopen" }).success).toBe(false);
  expect(nodeCommand.safeParse({ op: "session.open", sessionId: "s", sourceId: 1, mode: "create" }).success).toBe(false);
  expect(deliveryPolicy({ op: "session.prompt", sessionId: "s", clientId: "c", content: [] })).toBe("submit-work");
  // A model change is ordered with the session's queued work, not applied immediately.
  expect(deliveryPolicy({ op: "session.setModel", sessionId: "s", provider: "p", modelId: "m" })).toBe("submit-work");
  expect(deliveryPolicy({ op: "session.abort", sessionId: "s" })).toBe("request-now");
  // Relocation is ordered with the session's work: input submitted during a move waits behind it.
  expect(deliveryPolicy({ op: "session.hydrate", sessionId: "s", targetSourceId: 1 })).toBe("submit-work");
  expect(deliveryPolicy({ op: "session.release", sessionId: "s" })).toBe("submit-work");
  const snapshot = { harnessNextSeq: 3, rowCounts: { entries: 1, values: 1, lists: 0, usage: 0 }, digest: "a".repeat(64) };
  expect(nodeResult.safeParse({ ok: true, value: { kind: "released", snapshot } }).success).toBe(true);
  expect(nodeResult.safeParse({ ok: true, value: { kind: "released", snapshot: { ...snapshot, digest: "x" } } }).success).toBe(false);
});

test("semantic contract validates commands, results and observations without transport framing", () => {
  expect(contractVersion).toBe(5);
  expect(nodeCommand.parse({ op: "session.setModel", sessionId: "s", provider: "p", modelId: "m", thinkingLevel: "high" })).toMatchObject({ thinkingLevel: "high" });
  expect(nodeCommand.safeParse({ op: "session.setModel", sessionId: "s", provider: "", modelId: "m" }).success).toBe(false);
  expect(nodeResult.safeParse({ ok: true, value: { kind: "modelSet" } }).success).toBe(true);
  expect(nodeCommand.parse({ op: "session.steer", sessionId: "s", clientId: "c", content: [{ type: "text", text: "hi" }] }).op).toBe("session.steer");
  expect(nodeCommand.parse({ op: "session.prompt", sessionId: "s", clientId: "c", sourceSessionId: "child", content: [{ type: "image", attachmentId: "a", mimeType: "image/png", byteSize: 4 }] })).toMatchObject({ sourceSessionId: "child", content: [{ attachmentId: "a" }] });
  expect(nodeCommand.safeParse({ op: "session.shell", sessionId: "s" }).success).toBe(false);
  expect(nodeResult.safeParse({ ok: false, error: { code: "unavailable", message: "offline", retryable: true } }).success).toBe(true);
  expect(nodeEvent.safeParse({ sessionId: "s", kind: "canonical_entry", payload: { id: "entry" } }).success).toBe(true);
});
