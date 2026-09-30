import { test, expect } from "bun:test";
import { nodeCommand, nodeResult, deliveryPolicy, capability, sessionInputParams, sessionSetModelParams, sessionControlParams, sessionResumeParams, sessionCloseParams } from "./node-methods.js";
import { MAX_ATTACHMENT_BYTES, MAX_PROMPT_BLOCKS, MAX_PROMPT_TEXT } from "./fields.js";
import { methods } from "./node-connection.js";

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

test("every session command is a negotiated capability; inputs carry text and bounded image references only", () => {
  for (const method of [methods.sessionPrompt, methods.sessionSteer, methods.sessionAbort, methods.sessionResumePending, methods.sessionSetModel, methods.sessionClose]) {
    expect(capability.safeParse(method).success).toBe(true);
  }
  expect(capability.safeParse(methods.sessionStarted).success).toBe(false);
  expect(capability.safeParse("session.status").success).toBe(false);
  const binding = { sourceId: 1, cwd: "/tmp", createdAt: "now", parentSessionId: null };
  const image = { type: "image", attachmentId: "att_1", mimeType: "image/png", byteSize: 3, sha256: "a".repeat(64), width: 2, height: 1 };
  const task = { title: "T", description: null, branchName: "task/t" };
  const lane = { model: { provider: "p", modelId: "m" }, thinkingLevel: "high" };
  const input = { sessionId: "s", binding, task, lane, clientId: "client", content: [{ type: "text", text: "hi" }, image], sourceSessionId: null };
  const valid = (value: unknown) => sessionInputParams.safeParse(value).success;
  expect(valid(input)).toBe(true);
  expect(valid({ ...input, sourceSessionId: "parent" })).toBe(true);
  // Opening commands carry the task snapshot (null: a scratch session); it is required.
  expect(valid({ ...input, task: null })).toBe(true);
  expect(valid({ ...input, task: undefined })).toBe(false);
  // And the lane seed the node creates Pi's main lane from when the session has none.
  expect(valid({ ...input, lane: { model: null, thinkingLevel: null } })).toBe(true);
  expect(valid({ ...input, lane: undefined })).toBe(false);
  expect(valid({ ...input, commandId: "c" })).toBe(false);
  expect(valid({ ...input, sourceSessionId: undefined })).toBe(false);
  // Inline bytes, other block types, unsupported MIME types, unpaired dimensions and oversize claims are rejected.
  expect(valid({ ...input, content: [{ ...image, data: "AAAA" }] })).toBe(false);
  expect(valid({ ...input, content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] })).toBe(false);
  expect(valid({ ...input, content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }] })).toBe(false);
  expect(valid({ ...input, content: [{ ...image, mimeType: "image/tiff" }] })).toBe(false);
  expect(valid({ ...input, content: [{ ...image, height: undefined }] })).toBe(false);
  expect(valid({ ...input, content: [{ ...image, byteSize: MAX_ATTACHMENT_BYTES + 1 }] })).toBe(false);
  expect(valid({ ...input, content: Array.from({ length: MAX_PROMPT_BLOCKS + 1 }, () => ({ type: "text", text: "x" })) })).toBe(false);
  expect(valid({ ...input, content: [{ type: "text", text: "x".repeat(MAX_PROMPT_TEXT + 1) }] })).toBe(false);
  expect(valid({ ...input, projectId: 1 })).toBe(false);
  const setModel = { sessionId: "s", binding, task, lane, provider: "p", modelId: "m" };
  expect(sessionSetModelParams.safeParse(setModel).success).toBe(true);
  expect(sessionSetModelParams.safeParse({ ...setModel, thinkingLevel: "high" }).success).toBe(true);
  expect(sessionSetModelParams.safeParse({ ...setModel, commandId: "c" }).success).toBe(false);
  expect(sessionControlParams.safeParse({ sessionId: "s", binding }).success).toBe(true);
  expect(sessionControlParams.safeParse({ sessionId: "s", binding, extra: true }).success).toBe(false);
  expect(sessionResumeParams.safeParse({ sessionId: "s", binding, task: null, lane }).success).toBe(true);
  expect(sessionResumeParams.safeParse({ sessionId: "s", binding, lane }).success).toBe(false);
  // `session.close` names only the session: the server re-pointed it already.
  expect(sessionCloseParams.safeParse({ sessionId: "s" }).success).toBe(true);
  expect(sessionCloseParams.safeParse({ sessionId: "s", binding }).success).toBe(false);
});
