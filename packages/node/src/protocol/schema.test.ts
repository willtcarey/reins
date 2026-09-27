import { test, expect } from "bun:test";
import { helloParams, readyResult, provisionParams, sessionEventParams, attachmentStoreParams, attachmentStoreResult, MAX_ATTACHMENT_BYTES, sessionStartedParams, sessionSettledParams, scriptExecuteParams, scriptSearchParams, projectCreateTaskParams, methods } from "./schema.js";

test("version ranges and capabilities are validated at the wire boundary", () => {
  expect(helloParams.safeParse({ minVersion: 3, maxVersion: 1, instanceId: "n", capabilities: ["session.status"] }).success).toBe(false);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, instanceId: "n", capabilities: ["session.status", "future.optional"] }).success).toBe(true);
  expect(readyResult.safeParse({ version: 2, capabilities: ["session.status"], epoch: crypto.randomUUID() }).success).toBe(false);
  expect(readyResult.safeParse({ version: 1, capabilities: ["arbitrary.command"], epoch: crypto.randomUUID() }).success).toBe(false);
});

test("provision only accepts a scoped binding, stable command ID and the session's frozen configuration", () => {
  const binding = { sourceId: 1, cwd: "/tmp", createdAt: "now", parentSessionId: null };
  const configuration = { model: { provider: "p", modelId: "m" }, thinkingLevel: "high", task: { title: "T", description: null, branchName: "task/t" } };
  const provision = { epoch: crypto.randomUUID(), sessionId: "s", commandId: "c", binding, configuration };
  expect(provisionParams.safeParse({ ...provision, shell: "rm -rf /" }).success).toBe(false);
  expect(provisionParams.safeParse(provision).success).toBe(true);
  expect(provisionParams.safeParse({ ...provision, configuration: { model: null, thinkingLevel: null, task: null } }).success).toBe(true);
  expect(provisionParams.safeParse({ epoch: provision.epoch, sessionId: "s", commandId: "c", binding }).success).toBe(false);
  expect(provisionParams.safeParse({ ...provision, configuration: { ...configuration, task: { ...configuration.task, projectId: 2 } } }).success).toBe(false);
  expect(Object.values(methods)).not.toContain("session.configuration");
});

test("run lifecycle is a durable report, not a session event", () => {
  const epoch = crypto.randomUUID();
  const event = (value: unknown) => sessionEventParams.safeParse({ epoch, sessionId: "s", seq: 1, event: value }).success;
  expect(event({ type: "agent_end" })).toBe(true);
  expect(event({ type: "run_started", runId: "r" })).toBe(false);
  expect(event({ type: "run_settled", runId: "r", status: "completed", metadata: { model: null, thinkingLevel: null }, reply: null })).toBe(false);
  expect(sessionStartedParams.safeParse({ epoch, sessionId: "s", runId: "r" }).success).toBe(true);
  const settled = { epoch, sessionId: "s", runId: "r", status: "completed", metadata: { model: null, thinkingLevel: null }, reply: null };
  expect(sessionSettledParams.safeParse(settled).success).toBe(true);
  expect(sessionSettledParams.safeParse({ ...settled, replyError: "unreadable" }).success).toBe(true);
  expect(sessionSettledParams.safeParse({ ...settled, status: "running" }).success).toBe(false);
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

const toolResult = (block: unknown) => ({ role: "toolResult", content: [{ type: "text", text: "x" }, block] });

test("session events carry image references only; inline bytes are uploaded with attachment.store under node-assigned IDs", () => {
  const epoch = crypto.randomUUID();
  const event = (value: unknown) => sessionEventParams.safeParse({ epoch, sessionId: "s", seq: 1, event: value }).success;
  const reference = { type: "image", attachmentId: "att_1", mimeType: "image/png", byteSize: 3, sha256: "a".repeat(64) };
  const inline = { type: "image", data: "AAAA", mimeType: "image/png" };
  expect(event({ type: "message_end", streamId: "1", message: toolResult(reference) })).toBe(true);
  expect(event({ type: "message_end", streamId: "1", message: toolResult(inline) })).toBe(false);
  expect(event({ type: "message_end", streamId: "1", message: toolResult({ ...reference, data: "AAAA" }) })).toBe(false);
  expect(event({ type: "agent_end", messages: [toolResult(inline)] })).toBe(false);
  expect(event({ type: "tool_execution_end", toolCallId: "t", toolName: "read", isError: false, result: { content: [inline] } })).toBe(false);
  expect(event({ type: "tool_execution_update", toolCallId: "t", toolName: "read", args: {}, partialResult: { content: [inline] } })).toBe(false);
  // Only `content` arrays hold image blocks; tool arguments are not interpreted.
  expect(event({ type: "tool_execution_start", toolCallId: "t", toolName: "x", args: { image: inline } })).toBe(true);

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
