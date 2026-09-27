import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { insertEntry } from "@earendil-works/pi-agent-core/harness/session";
import { startNode, type Node } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";
import { createLoopbackPair, ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES } from "@reins/node/protocol";
import { openNodeStorage, recordNodeReport, setNodeDb } from "@reins/node/storage";
import { createServerTransport, type NodeSessionEvent, type ServerAttachment, type ServerHandlers } from "../../node-transport/server-peer.js";
import { applyNodeReplica } from "../../node-replica.js";
import { getDb } from "../../db.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../session-fixture.js";
import { setupTestDb, teardownTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";
import { nodeSessionReports } from "../../runtimes/node-session-events.js";
import { dispatcherFor } from "../../models/node-command-dispatcher.js";
import { getSession } from "../../session-store.js";

const binding = { sourceId: 1, cwd: "/tmp/server-calls", createdAt: "2026-01-01", parentSessionId: null };
const provision = { op: "session.provision" as const, sessionId: "s", sourceId: 1, configuration: { model: null, thinkingLevel: null, task: null } };

function link(node: Node, handlers: ServerHandlers) {
  const [serverEnd, nodeEnd] = createLoopbackPair();
  const server = createServerTransport(serverEnd, handlers);
  const connection = connectNode(node, nodeEnd, "test");
  serverEnd.onmessage = server.receive; serverEnd.onclose = server.close;
  nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
  return { serverEnd, connection, close: () => serverEnd.close() };
}

async function withNode(run: (node: Node, nodeDb: Database) => Promise<void>) {
  const nodeDb = new Database(":memory:");
  setNodeDb(nodeDb);
  const node = startNode();
  try {
    await node.send(provision, binding);
    await run(node, nodeDb);
  } finally { node.stop(); setNodeDb(); nodeDb.close(); }
}

const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5); };
const pending = (db: Database) => db.query<{ n: number }, []>("SELECT COUNT(*) n FROM session_outbox").get()!.n;
const unexpectedTool = () => { throw new Error("unexpected tool call"); };
const noTools = { scriptExecute: unexpectedTool, scriptSearch: unexpectedTool, createTask: unexpectedTool, findAttachment: () => null, storeAttachment: () => { throw new Error("unexpected attachment store"); }, readCredential: async () => null, refreshCredential: async () => null, listCredentials: async () => [] };
const noReports = { started: () => { throw new Error("unexpected report"); }, settled: () => { throw new Error("unexpected report"); }, ...noTools };

test("committed batches cross the wire byte-for-byte, survive a missing or lost link and are acknowledged idempotently", async () => {
  setupTestDb();
  try {
    createSession("s", createProject("Wire", "/tmp/server-calls").id, { agentRuntimeType: "pi" });
    await withNode(async (node, nodeDb) => {
      const storage = await openNodeStorage(nodeDb, "s", async () => { throw new Error("offline"); });
      await storage.commit([insertEntry({ id: "root", parentId: null, type: "custom", customType: "note", data: { text: "é \"quoted\"" } })], BACKGROUND_CONTEXT);
      await storage.close(BACKGROUND_CONTEXT);
      // Formatting a re-serialization would not preserve; the server compares receipts by exact string.
      const exact = JSON.stringify(JSON.parse(nodeDb.query<{ payload: string }, []>("SELECT payload FROM session_outbox").get()!.payload), null, 2);
      nodeDb.query("UPDATE session_outbox SET payload = ?").run(exact);

      expect(await node.send(provision, binding)).toMatchObject({ ok: true }); // delivery attempt with no link
      expect(pending(nodeDb)).toBe(1);

      const received: string[] = [];
      const handlers: ServerHandlers = {
        committed: ({ sessionId, startSeq, writesJson }) => { received.push(writesJson); applyNodeReplica(getDb(), sessionId, startSeq, writesJson); },
        attachment: () => null, event: () => {}, ...noReports,
      };
      link(node, handlers).close(); // lost before negotiation
      await Bun.sleep(5);
      expect(pending(nodeDb)).toBe(1);

      const live = link(node, handlers); // attaching replays pending batches
      await until(() => pending(nodeDb) === 0);
      expect(pending(nodeDb)).toBe(0);
      expect(received).toEqual([exact]);
      expect(getDb().query("SELECT writes_json FROM node_replica_receipts").get()).toEqual({ writes_json: exact });

      nodeDb.query("INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES('s','committed',1,?)").run(exact);
      await node.send(provision, binding);
      expect(pending(nodeDb)).toBe(0);
      expect(received).toEqual([exact, exact]);
      expect(getDb().query("SELECT COUNT(*) n FROM session_messages").get()).toEqual({ n: 1 });

      nodeDb.query("INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES('s','committed',1,?)").run(JSON.stringify(JSON.parse(exact)));
      await node.send(provision, binding);
      expect(pending(nodeDb)).toBe(1); // divergence is rejected, not acknowledged
      expect(received).toHaveLength(3);
      live.close();
    });
  } finally { teardownTestDb(); }
});

const settled = (runId: string, extra: Record<string, unknown> = {}) => JSON.stringify({ runId, status: "completed",
  metadata: { model: { provider: "p", modelId: "m" }, thinkingLevel: null }, reply: { text: `${runId} answer`, stopReason: "stop", errorMessage: null }, ...extra });

test("lifecycle reports cross the wire after preceding commits, stay pending without a link, and apply exactly once across a lost ack", async () => {
  setupTestDb();
  const state = createServerState();
  const parent = createRuntimeStub();
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const project = createProject("Lifecycle", "/tmp/server-calls");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    state.sessions.set("parent", { id: "parent", runtime: parent.runtime, lastActivity: 0 });
    createSession("s", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const reports = nodeSessionReports(state);
    const steers = () => parent.steerCalls.map(content => content.map(block => block.type === "text" ? block.text : "").join(""));
    await withNode(async (node, nodeDb) => {
      recordNodeReport(nodeDb, "s", "started", JSON.stringify({ runId: "r1" }));
      nodeDb.query("INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES('s','committed',1,'[]')").run();
      recordNodeReport(nodeDb, "s", "settled", settled("r1"));
      recordNodeReport(nodeDb, "s", "started", JSON.stringify({ runId: "r2" }));
      expect(await node.send(provision, binding)).toMatchObject({ ok: true }); // delivery attempt with no link
      expect(pending(nodeDb)).toBe(4);
      expect(getSession("s")?.activity_state).toBeNull();

      const received: string[] = [];
      let loseAck = true;
      const live = link(node, {
        committed: ({ startSeq }) => { received.push(`committed:${startSeq}`); }, attachment: () => null, event: () => {}, ...noTools,
        started: input => { received.push(`started:${input.runId}`); reports.started(input); },
        settled: input => {
          received.push(`settled:${input.runId}`);
          reports.settled(input);
          if (loseAck) { loseAck = false; throw new Error("acknowledgement lost"); }
        },
      });
      await until(() => received.length === 3);
      expect(pending(nodeDb)).toBe(2); // the applied settlement was not acknowledged
      for (let i = 0; i < 200 && parent.steerCalls.length === 0; i++) await Bun.sleep(5);
      expect(getSession("s")?.activity_state).toBeNull(); // reported to its parent

      await node.send(provision, binding); // replay
      await until(() => pending(nodeDb) === 0);
      expect(received).toEqual(["started:r1", "committed:1", "settled:r1", "settled:r1", "started:r2"]);
      expect(getSession("s")?.activity_state).toBe("running");
      await Bun.sleep(20);
      expect(steers()).toEqual(["r1 answer"]);

      recordNodeReport(nodeDb, "s", "settled", settled("r1", { status: "failed", error: { message: "rewritten" } }));
      await node.send(provision, binding);
      expect(pending(nodeDb)).toBe(1); // divergence is rejected and stays pending, without effects
      expect(getSession("s")?.activity_state).toBe("running");
      nodeDb.query("DELETE FROM session_outbox").run();

      // A child whose reply could not be read is finished without a misleading report to its parent.
      recordNodeReport(nodeDb, "s", "settled", settled("r2", { reply: null, replyError: "transcript unavailable" }));
      await node.send(provision, binding);
      await until(() => pending(nodeDb) === 0);
      expect(getSession("s")?.activity_state).toBe("finished");
      await Bun.sleep(20);
      expect(steers()).toEqual(["r1 answer"]);
      expect(getDb().query("SELECT run_id, kind FROM node_lifecycle_receipts ORDER BY run_id, kind").all()).toEqual([
        { run_id: "r1", kind: "settled" }, { run_id: "r1", kind: "started" }, { run_id: "r2", kind: "settled" }, { run_id: "r2", kind: "started" },
      ]);
      live.close();
    });
  } finally { errors.mockRestore(); dispatcherFor(state).stop(); teardownTestDb(); }
});

test("attachment fetch transfers chunked base64 bytes that the node verifies before caching", async () => {
  const bytes = new Uint8Array(ATTACHMENT_CHUNK_BYTES * 2 + 17).map((_, i) => (i * 31) % 251);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let served: ServerAttachment | null = { data: bytes, mimeType: "image/png", byteSize: bytes.length, sha256, filename: "a.png", width: 3, height: 4 };
  let fetches = 0;
  const prompt = (clientId: string, attachmentId: string) => ({ op: "session.prompt" as const, sessionId: "s", clientId,
    content: [{ type: "image" as const, attachmentId, mimeType: "image/png" as const, byteSize: bytes.length }] });
  await withNode(async (node, nodeDb) => {
    const live = link(node, { committed: () => {}, attachment: (sessionId, id) => {
      if (sessionId !== "s") throw new Error("wrong session");
      if (id === "img") fetches++;
      return served;
    }, event: () => {}, ...noReports });
    // Provisioned without a model, the open after caching stops before Pi.
    await expect(node.send(prompt("a", "img"), binding)).rejects.toThrow("AgentHarness Pi runtime requires an explicit model");
    expect(fetches).toBe(3);
    expect(nodeDb.query("SELECT data, filename, width, height FROM node_attachments WHERE attachment_id = 'img'").get())
      .toEqual({ data: Buffer.from(bytes), filename: "a.png", width: 3, height: 4 });

    served = { ...served!, sha256: "0".repeat(64) };
    expect(await node.send(prompt("b", "corrupt"), binding)).toMatchObject({ ok: false, error: { code: "invalid_request", message: "Attachment checksum mismatch: corrupt" } });
    served = { ...served, data: new Uint8Array(MAX_ATTACHMENT_BYTES + 1), byteSize: MAX_ATTACHMENT_BYTES + 1 };
    expect(await node.send(prompt("c", "huge"), binding)).toMatchObject({ ok: false, error: {
      code: "invalid_request", retryable: false, message: expect.stringContaining("exceeds 10485760 byte transfer limit") } });
    served = null;
    expect(await node.send(prompt("d", "gone"), binding)).toMatchObject({ ok: false, error: { code: "invalid_request", message: "Attachment unavailable: gone" } });
    expect(nodeDb.query("SELECT attachment_id FROM node_attachments").all()).toEqual([{ attachment_id: "img" }]);
    live.close();
  });
});

test("server rejects node calls with malformed params or an epoch it did not issue", async () => {
  const sent: Array<{ id: number; error?: { code: number } }> = [];
  const server = createServerTransport({ send: data => sent.push(JSON.parse(data)), close: () => {} }, {
    committed: () => { throw new Error("must not apply"); }, attachment: () => { throw new Error("must not read"); }, event: () => { throw new Error("must not observe"); }, ...noReports,
  });
  const frame = (id: number, method: string, params: unknown) => server.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const epoch = crypto.randomUUID();
  frame(1, "session.committed", { epoch, sessionId: "s", startSeq: 1, writesJson: "[]" });
  frame(2, "attachment.fetch", { epoch, sessionId: "s", attachmentId: "a" });
  frame(3, "session.committed", { epoch, sessionId: "s", startSeq: 0, writesJson: "[]" });
  frame(4, "attachment.fetch", { epoch, sessionId: "s", attachmentId: "a", offset: -1 });
  frame(5, "session.started", { epoch, sessionId: "s", runId: "r" });
  frame(6, "session.settled", { epoch, sessionId: "s", runId: "r", status: "running", metadata: { model: null, thinkingLevel: null }, reply: null });
  await Bun.sleep(5);
  expect(sent.map(reply => [reply.id, reply.error?.code]).toSorted((a, b) => a[0]! - b[0]!)).toEqual([[1, -32003], [2, -32003], [3, -32602], [4, -32602], [5, -32003], [6, -32602]]);
  server.close();
});

test("attachment.store resumes from the server's contiguous prefix and stores only verified bytes under the node's ID", async () => {
  const sent: Array<{ id?: number; result?: any; error?: { code: number; message: string } }> = [];
  const stored = new Map<string, ServerAttachment>();
  const server = createServerTransport({ send: data => sent.push(JSON.parse(data)), close: () => {} }, {
    committed: () => {}, attachment: () => null, event: () => {}, ...noReports,
    findAttachment: (_sessionId, attachmentId) => {
      const held = stored.get(attachmentId);
      return held ? { attachmentId, mimeType: held.mimeType, byteSize: held.byteSize, sha256: held.sha256 } : null;
    },
    storeAttachment: (_sessionId, attachmentId, attachment) => { stored.set(attachmentId, attachment); },
  });
  let id = 1;
  const call = async (method: string, params: unknown) => {
    const request = ++id;
    server.receive(JSON.stringify({ jsonrpc: "2.0", id: request, method, params }));
    await Bun.sleep(1);
    return sent.find(reply => reply.id === request)!;
  };
  server.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node.hello", params: { minVersion: 1, maxVersion: 1, capabilities: [], instanceId: "n" } }));
  await Bun.sleep(1);
  const epoch = sent[0]!.result.epoch;
  const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 10, 7);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const chunk = (offset: number, data = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES), attachmentId = "att_node", mimeType = "image/png") =>
    call("attachment.store", { epoch, sessionId: "s", attachmentId, mimeType, sha256, byteSize: bytes.length, offset, data: data.toString("base64") });
  expect((await chunk(ATTACHMENT_CHUNK_BYTES)).result).toEqual({ nextOffset: 0 }); // nothing held yet: start at 0
  expect((await chunk(0)).result).toEqual({ nextOffset: ATTACHMENT_CHUNK_BYTES });
  expect((await chunk(0)).result).toEqual({ nextOffset: ATTACHMENT_CHUNK_BYTES }); // retried chunk is not appended twice
  // The same ID with other metadata mid-upload is rejected and restarts.
  expect((await chunk(ATTACHMENT_CHUNK_BYTES, undefined, "att_node", "image/gif")).error).toMatchObject({ code: -32000, message: "Attachment upload changed: att_node" });
  expect((await chunk(ATTACHMENT_CHUNK_BYTES)).result).toEqual({ nextOffset: 0 });
  expect((await chunk(0)).result).toEqual({ nextOffset: ATTACHMENT_CHUNK_BYTES });
  expect(stored.size).toBe(0);
  expect((await chunk(ATTACHMENT_CHUNK_BYTES)).result).toEqual({ stored: true });
  expect([...stored.keys()]).toEqual(["att_node"]);
  expect(Buffer.from(stored.get("att_node")!.data)).toEqual(bytes);
  // A replay of a stored ID is answered at once; the same ID with different content is divergence.
  expect((await chunk(0)).result).toEqual({ stored: true });
  expect((await chunk(0, undefined, "att_node", "image/gif")).error).toMatchObject({ code: -32000, message: "Attachment att_node is already stored with different content" });
  // Tampered bytes fail verification and leave nothing buffered.
  expect((await chunk(0, undefined, "att_other")).result).toEqual({ nextOffset: ATTACHMENT_CHUNK_BYTES });
  expect((await chunk(ATTACHMENT_CHUNK_BYTES, Buffer.alloc(10, 8), "att_other")).error).toMatchObject({ code: -32000, message: "Attachment checksum mismatch: att_other" });
  expect((await chunk(ATTACHMENT_CHUNK_BYTES, undefined, "att_other")).result).toEqual({ nextOffset: 0 });
  expect(stored.size).toBe(1);
  expect((await call("attachment.store", { epoch: crypto.randomUUID(), sessionId: "s", attachmentId: "att_x", mimeType: "image/png", sha256, byteSize: 1, offset: 0, data: "AA==" })).error).toMatchObject({ code: -32003 });
  server.close();
});

test("session events reach the handler only for the issued epoch, in order, with gaps counted and no replies", async () => {
  const sent: Array<{ id?: number; result?: { epoch: string } }> = [];
  const received: NodeSessionEvent[] = [];
  const server = createServerTransport({ send: data => sent.push(JSON.parse(data)), close: () => {} }, {
    committed: () => {}, attachment: () => null, event: input => { received.push(input); }, ...noReports,
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    server.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node.hello", params: { minVersion: 1, maxVersion: 1, capabilities: [], instanceId: "n" } }));
    await Bun.sleep(1);
    const epoch = sent[0]!.result!.epoch;
    const event = (params: Record<string, unknown>) => server.receive(JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { epoch, sessionId: "s", ...params } }));
    event({ seq: 1, event: { type: "agent_start" } });
    event({ seq: 1, event: { type: "agent_end" } }); // replayed seq
    event({ seq: 4, event: { type: "agent_start" } });
    event({ seq: 5, epoch: crypto.randomUUID(), event: { type: "agent_start" } });
    event({ seq: 6, event: { type: "unknown_kind" } });
    event({ seq: 7, event: { type: "run_started", runId: "r" } }); // lifecycle is no longer a session event
    await Bun.sleep(1);
    expect(received).toEqual([
      { sessionId: "s", seq: 1, missed: 0, event: { type: "agent_start" } },
      { sessionId: "s", seq: 4, missed: 2, event: { type: "agent_start" } },
    ]);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(sent).toHaveLength(1);
  } finally { warn.mockRestore(); server.close(); }
});

test("script.execute abort stops the node waiting, cancels the server script's signal, and a closed link cancels in-flight scripts", async () => {
  await withNode(async node => {
    const signals: AbortSignal[] = [];
    const running = (_input: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    const live = link(node, { committed: () => {}, attachment: () => null, event: () => {}, ...noReports, scriptExecute: running });
    const controller = new AbortController();
    const call = live.connection.executeScript({ sessionId: "s", code: "await forever" }, controller.signal);
    await until(() => signals.length === 1);
    controller.abort();
    await expect(call).rejects.toMatchObject({ message: "Call aborted; outcome unknown", outcome: "unknown" });
    await until(() => signals[0]!.aborted);
    expect(signals[0]!.aborted).toBe(true);

    const orphan = live.connection.executeScript({ sessionId: "s", code: "await forever" });
    await until(() => signals.length === 2);
    live.close();
    await expect(orphan).rejects.toMatchObject({ outcome: "unknown" });
    await until(() => signals[1]!.aborted);
    expect(signals[1]!.aborted).toBe(true);
  });
});
