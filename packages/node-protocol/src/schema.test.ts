import { test, expect } from "bun:test";
import { storageReadParams, storageReadResult, storageCommitParams, storageCommitResult, attachmentFetchParams, helloParams, readyResult, sessionEventParams, attachmentStoreParams, attachmentStoreResult, sessionStartedParams, sessionSettledParams, scriptExecuteParams, scriptSearchParams, projectCreateTaskParams, methods, capability, sessionInputParams, sessionSetModelParams, sessionControlParams, sessionResumeParams, sessionCloseParams, MAX_LIVE_SESSIONS, protocolVersion, MAX_SESSION_EVENT_CHARS } from "./schema.js";
import { MAX_ATTACHMENT_BYTES, MAX_PROMPT_BLOCKS, MAX_PROMPT_TEXT } from "./contract.js";

test("version ranges and capabilities are validated at the wire boundary", () => {
  expect(helloParams.safeParse({ minVersion: 3, maxVersion: 1, nodeId: "n", capabilities: ["session.prompt"], liveSessions: [] }).success).toBe(false);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: ["session.prompt", "future.optional"], liveSessions: [] }).success).toBe(true);
  // Crash recovery: the node lists the sessions it has a run in progress for, bounded.
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: [], liveSessions: ["s1", "s2"] }).success).toBe(true);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: [] }).success).toBe(false);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: [], liveSessions: Array.from({ length: MAX_LIVE_SESSIONS + 1 }, (_, i) => `s${i}`) }).success).toBe(false);
  expect(readyResult.safeParse({ version: protocolVersion + 1, capabilities: ["session.prompt"], epoch: crypto.randomUUID() }).success).toBe(false);
  expect(readyResult.safeParse({ version: protocolVersion, capabilities: ["arbitrary.command"], epoch: crypto.randomUUID() }).success).toBe(false);
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

test("run lifecycle is a report, not a session event", () => {
  expect(sessionStartedParams.safeParse({ sessionId: "s", runId: "r" }).success).toBe(true);
  const settled = { sessionId: "s", runId: "r", status: "completed", metadata: { model: null, thinkingLevel: null }, tipId: null };
  expect(sessionSettledParams.safeParse(settled).success).toBe(true);
  expect(sessionSettledParams.safeParse({ ...settled, tipId: "completed-branch-tip" }).success).toBe(true);
  expect(sessionSettledParams.safeParse({ ...settled, status: "running" }).success).toBe(false);
});

test("a session event crosses as the node's serialized JSON; only its envelope is validated", () => {
  const params = (event: unknown, extra: Record<string, unknown> = {}) => sessionEventParams.safeParse({ sessionId: "s", seq: 1, emittedAt: 1_700_000_000_000, event, ...extra }).success;
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
  expect(methods).toMatchObject({ scriptExecute: "script.execute", scriptSearch: "script.search", projectCreateTask: "project.createTask" });
  expect(scriptExecuteParams.safeParse({ sessionId: "s", callId: "c", code: "return 1" }).success).toBe(true);
  expect(scriptExecuteParams.safeParse({ sessionId: "s", callId: "c", code: "return 1", projectId: 2 }).success).toBe(false);
  expect(scriptSearchParams.safeParse({ sessionId: "s", query: "", taskId: 3 }).success).toBe(false);
  expect(projectCreateTaskParams.safeParse({ sessionId: "s", title: "t", description: "d", projectId: 2 }).success).toBe(false);
  expect(projectCreateTaskParams.safeParse({ sessionId: "s", title: "t", description: "d", branchName: "task/t", prompt: "go" }).success).toBe(true);
});

test("inline image bytes are uploaded with attachment.store under node-assigned IDs", () => {
  // Every fetch names its chunk offset.
  expect(attachmentFetchParams.safeParse({ sessionId: "s", attachmentId: "a", offset: 0 }).success).toBe(true);
  expect(attachmentFetchParams.safeParse({ sessionId: "s", attachmentId: "a" }).success).toBe(false);
  const store = { sessionId: "s", attachmentId: "att_0b6f5c1e-7f35-4b5e-9d0a-2f1f0c3a9e11", mimeType: "image/png", sha256: "a".repeat(64), byteSize: 3, offset: 0, data: "AAAA" };
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

test("session storage calls are base node→server methods carrying one Pi read op or one Pi commit", () => {
  expect(methods).toMatchObject({ storageRead: "storage.read", storageCommit: "storage.commit" });
  expect(capability.safeParse(methods.storageRead).success).toBe(false);
  expect(capability.safeParse(methods.storageCommit).success).toBe(false);
  const read = (op: string, args: unknown) => storageReadParams.safeParse({ sessionId: "s", op, args }).success;
  expect(read("getEntries", { ids: ["a", "b"] })).toBe(true);
  expect(read("getValue", { namespace: "pi.branch.tip", key: "main" })).toBe(true);
  expect(read("readList", { namespace: "pi.frames", key: "", options: { cursor: { seq: 3 }, order: "desc", limit: 2 } })).toBe(true);
  expect(read("scanBranch", { start: "leaf", stopAtType: "compaction", order: "oldestFirst", cursor: { seq: 4 }, limit: 2 })).toBe(true);
  expect(read("scanEntries", { type: "custom", customType: "note", fromSeq: 1, toSeq: 9, order: "desc" })).toBe(true);
  expect(read("getStats", {})).toBe(true);
  // Unknown ops, arguments another op takes and Pi-invalid list limits are refused.
  expect(read("deleteSession", {})).toBe(false);
  expect(read("scanBranch", { order: "oldestFirst" })).toBe(false);
  expect(read("getStats", { namespace: "x", key: "" })).toBe(false);
  expect(read("readList", { namespace: "pi.frames", key: "", options: { limit: 0 } })).toBe(false);
  expect(storageReadParams.safeParse({ sessionId: "s", op: "getStats", args: {}, projectId: 1 }).success).toBe(false);

  const message = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
  const writes = [
    { kind: "entry", entry: { id: "e1", parentId: null, type: "message", message } },
    { kind: "usage", row: { id: "u1", entryId: "e1", adjustment: false, usage: { input: 1, output: 2, cost: { total: 0 } } } },
    { kind: "value", op: "set", namespace: "pi.branch.tip", key: "main", value: "e1" },
    { kind: "value", op: "delete", namespace: "pi.pending", key: "e1" },
    { kind: "list", op: "append", namespace: "pi.frames", key: "op", value: { frame: 1 } },
    { kind: "list", op: "delete", namespace: "pi.frames", key: "op" },
  ];
  const commit: unknown = storageCommitParams.parse({ sessionId: "s", writes });
  // Pi's bodies cross unchanged: an entry keeps its payload.
  expect(commit).toEqual({ sessionId: "s", writes });
  const refused = (write: unknown) => !storageCommitParams.safeParse({ sessionId: "s", writes: [write] }).success;
  expect(refused({ kind: "entry", entry: { parentId: null, type: "message", message } })).toBe(true);
  expect(refused({ kind: "entry", entry: { id: "e2", parentId: null, type: "note" } })).toBe(true);
  expect(refused({ kind: "value", op: "append", namespace: "n", key: "k", value: 1 })).toBe(true);
  expect(refused({ kind: "value", op: "delete", namespace: "n", key: "k", seq: 4 })).toBe(true);
  expect(refused({ kind: "usage", row: { id: "u2", adjustment: false, usage: [] } })).toBe(true);
  expect(storageCommitResult.safeParse({ firstSeq: 1, seqs: [1, 2], timestamp: 5, stats: { messageCount: 1, usage: { input: 1 } } }).success).toBe(true);
});

test("storage read results name their op and pass Pi's entries and values through", () => {
  const entry = { id: "e1", parentId: null, seq: 1, timestamp: 5, type: "custom" as const, customType: "note", data: { nested: [1, 2] } };
  expect(storageReadResult.parse({ op: "getEntries", entries: [entry] })).toEqual({ op: "getEntries", entries: [entry] });
  // Pi's absent value is null; a stored null is a value.
  expect(storageReadResult.safeParse({ op: "getValue", value: null }).success).toBe(true);
  expect(storageReadResult.parse({ op: "getValue", value: { namespace: "n", key: "k", value: null, seq: 2 } })).toEqual({ op: "getValue", value: { namespace: "n", key: "k", value: null, seq: 2 } });
  expect(storageReadResult.safeParse({ op: "scanBranch", entries: [{ ...entry, seq: undefined }] }).success).toBe(false);
  expect(storageReadResult.safeParse({ op: "scanBranchStructure", entries: [entry] }).success).toBe(false);
  expect(storageReadResult.safeParse({ op: "getStats", entries: [] }).success).toBe(false);
});
