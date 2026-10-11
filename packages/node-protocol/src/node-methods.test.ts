import { test, expect } from "bun:test";
import { nodeCommand, nodeResult, capability, sessionInputParams, sessionSetModelParams, sessionAbortParams, sessionResumeParams, sessionCloseParams } from "./node-methods.js";
import { MAX_ATTACHMENT_BYTES, MAX_PROMPT_BLOCKS, MAX_PROMPT_CONTENT_BYTES, MAX_PROMPT_TEXT, MAX_SYSTEM_PROMPT_CHARS, promptContentBytes } from "./fields.js";
import { methods } from "./negotiation.js";
import { REMOTE_MAX_FRAME_BYTES } from "./websocket-link.js";

test("stored commands are only the outbox's submitted work: abort, resume and their results are not commands", () => {
  for (const op of ["session.abort", "session.resumePending", "session.close"]) expect(nodeCommand.safeParse({ op, sessionId: "s" }).success).toBe(false);
  expect(nodeResult.safeParse({ ok: true, value: { aborted: true } }).success).toBe(false);
  expect(nodeResult.safeParse({ ok: true, value: { started: true } }).success).toBe(false);
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
  const lane = { model: { provider: "p", modelId: "m" }, thinkingLevel: "high" };
  const runtime = { systemPrompt: "You are REINS.", environment: true };
  const input = { sessionId: "s", binding, branch: "task/t", lane, runtime, clientId: "client", content: [{ type: "text", text: "hi" }, image], sourceSessionId: null };
  const valid = (value: unknown) => sessionInputParams.safeParse(value).success;
  expect(valid(input)).toBe(true);
  expect(valid({ ...input, sourceSessionId: "parent" })).toBe(true);
  // Opening commands carry the task branch to check out (null: a scratch session); it is required.
  expect(valid({ ...input, branch: null })).toBe(true);
  expect(valid({ ...input, branch: undefined })).toBe(false);
  // And the runtime configuration the server resolved from the session's kind: the system prompt, the
  // active tools (absent: every tool) and whether the node appends its environment.
  expect(valid({ ...input, runtime: { systemPrompt: "Sort these.", tools: [], environment: false } })).toBe(true);
  expect(valid({ ...input, runtime: undefined })).toBe(false);
  expect(valid({ ...input, runtime: { systemPrompt: "x" } })).toBe(false);
  expect(valid({ ...input, runtime: { ...runtime, tools: [""] } })).toBe(false);
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
  const setModel = { sessionId: "s", binding, branch: null, lane, runtime, provider: "p", modelId: "m" };
  expect(sessionSetModelParams.safeParse(setModel).success).toBe(true);
  expect(sessionSetModelParams.safeParse({ ...setModel, thinkingLevel: "high" }).success).toBe(true);
  expect(sessionSetModelParams.safeParse({ ...setModel, commandId: "c" }).success).toBe(false);
  expect(sessionAbortParams.safeParse({ sessionId: "s", binding }).success).toBe(true);
  expect(sessionAbortParams.safeParse({ sessionId: "s", binding, extra: true }).success).toBe(false);
  expect(sessionResumeParams.safeParse({ sessionId: "s", binding, branch: null, lane, runtime }).success).toBe(true);
  expect(sessionResumeParams.safeParse({ sessionId: "s", binding, branch: null, lane }).success).toBe(false);
  // `session.close` names only the session: the server re-pointed it already.
  expect(sessionCloseParams.safeParse({ sessionId: "s" }).success).toBe(true);
  expect(sessionCloseParams.safeParse({ sessionId: "s", binding }).success).toBe(false);
});

/** `length` characters that JSON escapes to six bytes each. */
const escaped = (length: number) => "\u0001".repeat(length);

test("the largest prompt or steer the bounds allow fits one frame on the remote link; longer content is refused", () => {
  // Every bounded string at its longest, of a character JSON escapes to six bytes; the content at its
  // byte bound.
  const id = escaped(128);
  const text = (bytes: number) => {
    const room = bytes - promptContentBytes([{ type: "text", text: "" }]);
    return [{ type: "text", text: "€".repeat(Math.floor(room / 3)) + "x".repeat(room % 3) }];
  };
  const input = {
    sessionId: id, clientId: id, sourceSessionId: id,
    binding: { sourceId: Number.MAX_SAFE_INTEGER, cwd: escaped(4096), createdAt: id, parentSessionId: id },
    branch: escaped(1024),
    lane: { model: { provider: id, modelId: escaped(256) }, thinkingLevel: escaped(32) },
    runtime: { systemPrompt: escaped(MAX_SYSTEM_PROMPT_CHARS), tools: Array.from({ length: 256 }, () => id), environment: true },
    content: text(MAX_PROMPT_CONTENT_BYTES),
  };
  expect(sessionInputParams.safeParse(input).success).toBe(true);
  const frame = JSON.stringify({ jsonrpc: "2.0", id: `rpc-${Number.MAX_SAFE_INTEGER}`, method: methods.sessionSteer, params: { ...input, epoch: crypto.randomUUID() } });
  expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(REMOTE_MAX_FRAME_BYTES);

  expect(sessionInputParams.safeParse({ ...input, content: text(MAX_PROMPT_CONTENT_BYTES + 1) }).success).toBe(false);
  expect(sessionInputParams.safeParse({ ...input, binding: { ...input.binding, parentSessionId: escaped(129) } }).success).toBe(false);
  expect(nodeCommand.safeParse({ op: "session.prompt", sessionId: "s", clientId: "c", sourceSessionId: null, content: text(MAX_PROMPT_CONTENT_BYTES + 1) }).success).toBe(false);
});
