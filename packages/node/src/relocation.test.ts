import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { insertEntry } from "@earendil-works/pi-agent-core/harness/session";
import { bindNodeSession, initializeNodeStorage, nodeSessionBinding, nodeSessionTask, openNodeStorage } from "./storage.js";
import { piSnapshotSummary, readPiSnapshotPage, samePiSnapshot } from "./pi-storage.js";
import { hydrateNodeSession, releasedSnapshot, releaseNodeSession, type RelocationServer } from "./relocation.js";
import { APPLICATION_ERROR } from "./protocol/errors.js";
import { RpcFailure } from "./protocol/peer.js";

const binding = { sourceId: 1, cwd: "/tmp/relocation", createdAt: "2026-01-01", parentSessionId: null };
const task = { title: "Task", description: null, branchName: "task/relocation" };
const bytes = new Uint8Array([1, 2, 3]);
const sha256 = createHash("sha256").update(bytes).digest("hex");

/** A server copy of session "s" whose first entry references attachment "att_1". */
async function serverCopy() {
  const server = new Database(":memory:");
  initializeNodeStorage(server);
  bindNodeSession(server, "s", binding);
  const storage = await openNodeStorage(server, "s", async () => {}, () => 42);
  await storage.commit([
    insertEntry({ id: "root", parentId: null, type: "custom", customType: "note", data: { content: [{ type: "image", attachmentId: "att_1", mimeType: "image/png", byteSize: 3, sha256 }] } }),
    insertEntry({ id: "child", parentId: "root", type: "custom", customType: "note", data: { inline: [{ type: "image", data: "AAAA", mimeType: "image/png" }] } }),
    setValue(value("pi.branch.tip", "main"), "child"),
  ], BACKGROUND_CONTEXT);
  await storage.close(BACKGROUND_CONTEXT);
  const calls = { pages: 0, fetches: 0 };
  const serve: RelocationServer = {
    async snapshot(sessionId, fromSeq) { calls.pages++; return { summary: piSnapshotSummary(server, sessionId), ...readPiSnapshotPage(server, sessionId, fromSeq, 1) }; },
    async fetchAttachment(_sessionId, attachmentId) {
      calls.fetches++;
      return attachmentId === "att_1" ? { data: bytes, mimeType: "image/png", byteSize: 3, sha256 } : null;
    },
  };
  return { server, serve, calls, snapshot: piSnapshotSummary(server, "s") };
}

test("hydrate pulls the server's copy page by page with its attachments, stores it verbatim and converges on replay by content", async () => {
  const { server, serve, calls, snapshot } = await serverCopy();
  const node = new Database(":memory:");
  initializeNodeStorage(node);
  expect(await hydrateNodeSession(node, serve, { sessionId: "s", commandId: "h1", binding, task, snapshot })).toBeNull();
  expect(calls).toEqual({ pages: 3, fetches: 1 });
  expect(nodeSessionBinding(node, "s")).toEqual(binding);
  expect(nodeSessionTask(node, "s")).toEqual(task);
  expect(samePiSnapshot(piSnapshotSummary(node, "s"), snapshot)).toBe(true);
  expect(node.query("SELECT attachment_id, data FROM node_attachments").all()).toEqual([{ attachment_id: "att_1", data: Buffer.from(bytes) }]);
  expect(node.query("SELECT operation FROM admission_receipts WHERE command_id = 'h1'").get()).toEqual({ operation: "session.hydrate" });

  // A replay (a lost acknowledgement, or another command ID) finds the identical copy: no second pull.
  expect(await hydrateNodeSession(node, serve, { sessionId: "s", commandId: "h1", binding, task, snapshot })).toBeNull();
  expect(await hydrateNodeSession(node, serve, { sessionId: "s", commandId: "h2", binding, task, snapshot })).toBeNull();
  expect(calls).toEqual({ pages: 3, fetches: 1 });
  // A different copy (or binding) is never overwritten.
  const other = { ...snapshot, harnessNextSeq: snapshot.harnessNextSeq + 1 };
  expect(await hydrateNodeSession(node, serve, { sessionId: "s", commandId: "h3", binding, task, snapshot: other }))
    .toEqual({ code: "invalid_request", message: "Node already holds a different copy of session s", retryable: false });
  expect(await hydrateNodeSession(node, serve, { sessionId: "s", commandId: "h4", binding: { ...binding, cwd: "/elsewhere" }, task, snapshot }))
    .toMatchObject({ code: "invalid_request" });
  server.close(); node.close();
});

test("hydrate stores nothing when the pull does not match its snapshot, an attachment is corrupt or the server is unreachable", async () => {
  const { server, serve, snapshot } = await serverCopy();
  const node = new Database(":memory:");
  initializeNodeStorage(node);
  const stored = () => node.query("SELECT COUNT(*) n FROM sessions").get();
  const forged: RelocationServer = { ...serve, async snapshot(sessionId, fromSeq) {
    const page = await serve.snapshot(sessionId, fromSeq);
    return { ...page, rows: page.rows.map(row => row.table === "value" ? { ...row, valueJson: '"root"' } : row) };
  } };
  expect(await hydrateNodeSession(node, forged, { sessionId: "s", commandId: "h", binding, task, snapshot }))
    .toEqual({ code: "invalid_request", message: "Hydration verification failed for session s: pulled rows do not match the snapshot", retryable: false });
  const changed = { ...snapshot, digest: "0".repeat(64) };
  expect(await hydrateNodeSession(node, serve, { sessionId: "s", commandId: "h", binding, task, snapshot: changed }))
    .toEqual({ code: "invalid_request", message: "Server copy of session s changed during hydration", retryable: false });
  const corrupt: RelocationServer = { ...serve, fetchAttachment: async () => ({ data: bytes, mimeType: "image/png", byteSize: 3, sha256: "f".repeat(64) }) };
  expect(await hydrateNodeSession(node, corrupt, { sessionId: "s", commandId: "h", binding, task, snapshot }))
    .toEqual({ code: "invalid_request", message: "Attachment checksum mismatch: att_1", retryable: false });
  const offline: RelocationServer = { ...serve, snapshot: async () => { throw new RpcFailure("unavailable", "Connection closed; outcome unknown", "unknown"); } };
  expect(await hydrateNodeSession(node, offline, { sessionId: "s", commandId: "h", binding, task, snapshot }))
    .toMatchObject({ code: "unavailable", retryable: true });
  const refused: RelocationServer = { ...serve, snapshot: async () => { throw new RpcFailure(APPLICATION_ERROR, "Node session unavailable: s"); } };
  expect(await hydrateNodeSession(node, refused, { sessionId: "s", commandId: "h", binding, task, snapshot }))
    .toEqual({ code: "invalid_request", message: "Session snapshot failed: Node session unavailable: s", retryable: false });
  expect(stored()).toEqual({ n: 0 });
  expect(node.query("SELECT COUNT(*) n FROM admission_receipts").get()).toEqual({ n: 0 });
  // An attachment the server no longer holds (pruned) does not block the move.
  const pruned: RelocationServer = { ...serve, fetchAttachment: async () => null };
  expect(await hydrateNodeSession(node, pruned, { sessionId: "s", commandId: "h", binding, task, snapshot })).toBeNull();
  expect(node.query("SELECT COUNT(*) n FROM node_attachments").get()).toEqual({ n: 0 });
  server.close(); node.close();
});

test("release waits for the outbox, refuses a server copy that differs, then drops everything and answers replays from its receipt", async () => {
  const { server, serve, snapshot } = await serverCopy();
  const node = new Database(":memory:");
  initializeNodeStorage(node);
  expect(await hydrateNodeSession(node, serve, { sessionId: "s", commandId: "h", binding, task, snapshot })).toBeNull();
  // A report the server has not acknowledged yet.
  node.query("INSERT INTO session_outbox(session_id,kind,payload) VALUES('s','started','{\"runId\":\"r\"}')").run();
  expect(await releaseNodeSession(node, serve, "s", "r1")).toMatchObject({ code: "unavailable", retryable: true });
  node.query("DELETE FROM session_outbox").run();
  // The server's copy is behind the node's: nothing is dropped.
  node.query("UPDATE sessions SET harness_next_seq = harness_next_seq + 1").run();
  expect(await releaseNodeSession(node, serve, "s", "r1")).toEqual({ code: "internal", message: "Server copy of session s differs from the node's; release refused", retryable: false });
  node.query("UPDATE sessions SET harness_next_seq = harness_next_seq - 1").run();

  expect(await releaseNodeSession(node, serve, "s", "r1")).toEqual({ snapshot });
  for (const table of ["sessions", "session_messages", "pi_values", "pi_lists", "pi_usage", "node_attachments", "session_outbox"]) {
    expect(node.query(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
  }
  expect(node.query("SELECT command_id, operation FROM admission_receipts").all()).toEqual([{ command_id: "r1", operation: "session.release" }]);
  expect(releasedSnapshot(node, "r1", "s")).toEqual(snapshot);
  expect(releasedSnapshot(node, "unknown", "s")).toBeNull();
  server.close(); node.close();
});
