import { test, expect } from "bun:test";
import { attachmentFetchParams, helloParams, readyResult, provisionParams, sessionEventParams, attachmentStoreParams, attachmentStoreResult, sessionStartedParams, sessionSettledParams, scriptExecuteParams, scriptSearchParams, projectCreateTaskParams, methods, capability, sessionInputParams, sessionSetModelParams, sessionControlParams, protocolVersion, MAX_SESSION_EVENT_CHARS } from "./schema.js";
import { MAX_ATTACHMENT_BYTES, MAX_PROMPT_BLOCKS, MAX_PROMPT_TEXT } from "./contract.js";

test("version ranges and capabilities are validated at the wire boundary", () => {
  expect(helloParams.safeParse({ minVersion: 3, maxVersion: 1, nodeId: "n", capabilities: ["session.prompt"] }).success).toBe(false);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: ["session.prompt", "future.optional"] }).success).toBe(true);
  expect(readyResult.safeParse({ version: protocolVersion + 1, capabilities: ["session.prompt"], epoch: crypto.randomUUID() }).success).toBe(false);
  expect(readyResult.safeParse({ version: protocolVersion, capabilities: ["arbitrary.command"], epoch: crypto.randomUUID() }).success).toBe(false);
});

test("provision only accepts a scoped binding and the session's frozen configuration", () => {
  const binding = { sourceId: 1, cwd: "/tmp", createdAt: "now", parentSessionId: null };
  const configuration = { model: { provider: "p", modelId: "m" }, thinkingLevel: "high", task: { title: "T", description: null, branchName: "task/t" } };
  const provision = { epoch: crypto.randomUUID(), sessionId: "s", binding, configuration };
  expect(provisionParams.safeParse({ ...provision, shell: "rm -rf /" }).success).toBe(false);
  expect(provisionParams.safeParse(provision).success).toBe(true);
  expect(provisionParams.safeParse({ ...provision, configuration: { model: null, thinkingLevel: null, task: null } }).success).toBe(true);
  expect(provisionParams.safeParse({ epoch: provision.epoch, sessionId: "s", binding }).success).toBe(false);
  // The node keeps no per-command state, so no outbox command ID crosses the wire.
  expect(provisionParams.safeParse({ ...provision, commandId: "c" }).success).toBe(false);
  expect(provisionParams.safeParse({ ...provision, configuration: { ...configuration, task: { ...configuration.task, projectId: 2 } } }).success).toBe(false);
  expect(Object.values(methods)).not.toContain("session.configuration");
});

test("every session command is a negotiated capability; inputs carry text and bounded image references only", () => {
  for (const method of [methods.sessionPrompt, methods.sessionSteer, methods.sessionAbort, methods.sessionResumePending, methods.sessionSetModel]) {
    expect(capability.safeParse(method).success).toBe(true);
  }
  expect(capability.safeParse(methods.sessionCommitted).success).toBe(false);
  expect(capability.safeParse("session.status").success).toBe(false);
  const binding = { sourceId: 1, cwd: "/tmp", createdAt: "now", parentSessionId: null };
  const image = { type: "image", attachmentId: "att_1", mimeType: "image/png", byteSize: 3, sha256: "a".repeat(64), width: 2, height: 1 };
  const input = { epoch: crypto.randomUUID(), sessionId: "s", binding, clientId: "client", content: [{ type: "text", text: "hi" }, image], sourceSessionId: null };
  const valid = (value: unknown) => sessionInputParams.safeParse(value).success;
  expect(valid(input)).toBe(true);
  expect(valid({ ...input, sourceSessionId: "parent" })).toBe(true);
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
  const setModel = { epoch: input.epoch, sessionId: "s", binding, provider: "p", modelId: "m" };
  expect(sessionSetModelParams.safeParse(setModel).success).toBe(true);
  expect(sessionSetModelParams.safeParse({ ...setModel, thinkingLevel: "high" }).success).toBe(true);
  expect(sessionSetModelParams.safeParse({ ...setModel, commandId: "c" }).success).toBe(false);
  expect(sessionControlParams.safeParse({ epoch: input.epoch, sessionId: "s", binding }).success).toBe(true);
  expect(sessionControlParams.safeParse({ epoch: input.epoch, sessionId: "s", binding, extra: true }).success).toBe(false);
});

test("run lifecycle is a durable report, not a session event", () => {
  const epoch = crypto.randomUUID();
  expect(sessionStartedParams.safeParse({ epoch, sessionId: "s", runId: "r" }).success).toBe(true);
  const settled = { epoch, sessionId: "s", runId: "r", status: "completed", metadata: { model: null, thinkingLevel: null }, reply: null };
  expect(sessionSettledParams.safeParse(settled).success).toBe(true);
  expect(sessionSettledParams.safeParse({ ...settled, replyError: "unreadable" }).success).toBe(true);
  expect(sessionSettledParams.safeParse({ ...settled, status: "running" }).success).toBe(false);
});

test("a session event crosses as the node's serialized JSON; only its envelope is validated", () => {
  const epoch = crypto.randomUUID();
  const params = (event: unknown, extra: Record<string, unknown> = {}) => sessionEventParams.safeParse({ epoch, sessionId: "s", seq: 1, emittedAt: 1_700_000_000_000, event, ...extra }).success;
  expect(params(JSON.stringify({ type: "agent_start" }))).toBe(true);
  // The payload is opaque to the schema: the node alone guarantees its shape and image references.
  expect(params(JSON.stringify({ type: "unknown_kind", content: [{ type: "image", data: "AAAA" }] }))).toBe(true);
  expect(params({ type: "agent_start" })).toBe(false);
  expect(params("")).toBe(false);
  expect(params("x".repeat(MAX_SESSION_EVENT_CHARS + 1))).toBe(false);
  expect(params(JSON.stringify({ type: "agent_start" }), { seq: -1 })).toBe(false);
  expect(params(JSON.stringify({ type: "agent_start" }), { emittedAt: undefined })).toBe(false);
  expect(params(JSON.stringify({ type: "agent_start" }), { projectId: 1 })).toBe(false);
});

test("agent tool calls carry only the calling session, never a project or task scope", () => {
  const epoch = crypto.randomUUID();
  expect(methods).toMatchObject({ scriptExecute: "script.execute", scriptSearch: "script.search", projectCreateTask: "project.createTask" });
  expect(scriptExecuteParams.safeParse({ epoch, sessionId: "s", callId: "c", code: "return 1" }).success).toBe(true);
  expect(scriptExecuteParams.safeParse({ epoch, sessionId: "s", callId: "c", code: "return 1", projectId: 2 }).success).toBe(false);
  expect(scriptSearchParams.safeParse({ epoch, sessionId: "s", query: "", taskId: 3 }).success).toBe(false);
  expect(projectCreateTaskParams.safeParse({ epoch, sessionId: "s", title: "t", description: "d", projectId: 2 }).success).toBe(false);
  expect(projectCreateTaskParams.safeParse({ epoch, sessionId: "s", title: "t", description: "d", branchName: "task/t", prompt: "go" }).success).toBe(true);
});

test("inline image bytes are uploaded with attachment.store under node-assigned IDs", () => {
  const epoch = crypto.randomUUID();
  // Every fetch names its chunk offset.
  expect(attachmentFetchParams.safeParse({ epoch, sessionId: "s", attachmentId: "a", offset: 0 }).success).toBe(true);
  expect(attachmentFetchParams.safeParse({ epoch, sessionId: "s", attachmentId: "a" }).success).toBe(false);
  const store = { epoch, sessionId: "s", attachmentId: "att_0b6f5c1e-7f35-4b5e-9d0a-2f1f0c3a9e11", mimeType: "image/png", sha256: "a".repeat(64), byteSize: 3, offset: 0, data: "AAAA" };
  expect(methods.attachmentStore).toBe("attachment.store");
  expect(attachmentStoreParams.safeParse(store).success).toBe(true);
  expect(attachmentStoreParams.safeParse({ ...store, byteSize: MAX_ATTACHMENT_BYTES + 1 }).success).toBe(false);
  expect(attachmentStoreParams.safeParse({ ...store, sha256: "nothex" }).success).toBe(false);
  // The node assigns the ID; it must be URL- and transcript-safe.
  const { attachmentId: _omitted, ...unassigned } = store;
  expect(attachmentStoreParams.safeParse(unassigned).success).toBe(false);
  expect(attachmentStoreParams.safeParse({ ...store, attachmentId: "../other" }).success).toBe(false);
  expect(attachmentStoreResult.safeParse({ nextOffset: 524288 }).success).toBe(true);
  expect(attachmentStoreResult.safeParse({ stored: true }).success).toBe(true);
  expect(attachmentStoreResult.safeParse({ attachment: { attachmentId: "att_1", mimeType: "image/png", byteSize: 3, sha256: "a".repeat(64) } }).success).toBe(false);
});
