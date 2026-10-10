import { expect, test } from "bun:test";
import { appendList, BACKGROUND_CONTEXT, list, setValue, value } from "@earendil-works/pi-agent-core";
import { insertEntry } from "@earendil-works/pi-agent-core/harness/session";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { RemoteStorage } from "@reins/node/remote-storage";
import { APPLICATION_ERROR, createNodeConnection, protocolVersion } from "@reins/node-protocol";
import { scriptedCommandHandlers } from "@reins/node-protocol/testing";
import { getDb } from "../../db.js";
import { PiStorageAdapter } from "../../pi-storage.js";
import { createSource, defaultSource } from "../../node-store.js";
import { createProject } from "../project-fixture.js";
import { createSession } from "../../session-store.js";
import { dialLoopback, SEEDED_NODE_ID, type DialOptions } from "../helpers/loopback-node.js";
import { createServerState } from "../helpers/server-state.js";
import { setupTestDb, teardownTestDb } from "../helpers/test-db.js";

/** A node end that only calls the server, connected through the hub's real `accept` as `nodeId`, both
 * ends capped at `maxFrameBytes` (uncapped by default). */
function storageConnection({ nodeId = SEEDED_NODE_ID, maxFrameBytes = Infinity, serverSocket }: { nodeId?: string; maxFrameBytes?: number; serverSocket?: DialOptions["serverSocket"] } = {}) {
  let connection!: ReturnType<typeof createNodeConnection>;
  const link = dialLoopback(createServerState(), socket => (connection = createNodeConnection(socket, {
    nodeId, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], liveSessions: [], maxFrameBytes, ...scriptedCommandHandlers({}),
  })), { redial: false, maxFrameBytes, ...(serverSocket ? { serverSocket } : {}) });
  return { connection, link };
}

/** A link frame cap far below some payloads: a read result or commit over a quarter of it crosses in parts,
 * and any frame over it would fail its call (sending) or close the link (receiving). */
const SMALL_FRAME_BYTES = 4096;
/** Several times the small cap, with characters that take more than one byte (and surrogate pairs a part
 * boundary may split) and characters JSON escapes. */
const large = (fill: string) => `${fill}: ${"ü😀\\\"\n".repeat(3000)}`;

const harnessNextSeq = (sessionId: string) => getDb().query<{ harness_next_seq: number }, [string]>("SELECT harness_next_seq FROM sessions WHERE id = ?").get(sessionId)?.harness_next_seq;

// Pi's own Storage contract, met by the server's canonical storage as the node reaches it over the link,
// whose small frame cap makes its larger reads and commits cross in parts.
for (const testCase of createStorageConformance(async () => {
  setupTestDb();
  const project = createProject("Remote storage", "/tmp/remote-storage");
  createSession("session", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id });
  const { connection, link } = storageConnection({ maxFrameBytes: SMALL_FRAME_BYTES });
  const storage = new RemoteStorage("session", connection);
  return {
    storage,
    async [Symbol.asyncDispose]() {
      await storage.close(BACKGROUND_CONTEXT);
      link.stop();
      teardownTestDb();
    },
  };
})) test(`RemoteStorage: ${testCase.group}: ${testCase.name}`, testCase.run);

test("a node reads and commits only sessions whose source is on it", async () => {
  setupTestDb();
  const { connection, link } = storageConnection();
  try {
    const project = createProject("Fenced", "/tmp/fenced");
    getDb().query("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')").run();
    createSession("foreign", project.id, { agentRuntimeType: "pi", sourceId: createSource(project.id, "remote", "/tmp/remote-fenced").id });
    createSession("own", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id });

    const foreign = new RemoteStorage("foreign", connection);
    const refused = { code: APPLICATION_ERROR, data: { code: "not_owner", message: "Node session unavailable: foreign", retryable: false } };
    await expect(foreign.getStats(BACKGROUND_CONTEXT)).rejects.toMatchObject(refused);
    await expect(foreign.commit([setValue(value("pi.branch.tip", "main"), null)], BACKGROUND_CONTEXT)).rejects.toMatchObject(refused);
    expect(harnessNextSeq("foreign")).toBe(1);

    // This node's source: this node's to read and write.
    const own = new RemoteStorage("own", connection);
    await own.commit([setValue(value("pi.branch.tip", "main"), null)], BACKGROUND_CONTEXT);
    expect(await own.getValue(value("pi.branch.tip", "main"), BACKGROUND_CONTEXT)).toEqual({ address: value("pi.branch.tip", "main"), value: null, seq: 1 });
  } finally { link.stop(); teardownTestDb(); }
});

test("a commit resent under its commitId (its reply lost) is answered with its first result and applied once", async () => {
  setupTestDb();
  const { connection, link } = storageConnection();
  try {
    const project = createProject("Resent", "/tmp/resent");
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id });
    // A list append has no ID of its own: only the commit's ID tells the resend apart from a new append.
    const commit = { sessionId: "owned", commitId: "commit-1", writes: [{ kind: "list" as const, op: "append" as const, namespace: "pi.frames", key: "op", value: "frame" }] };
    const first = await connection.commitStorage(commit);

    expect(await connection.commitStorage(commit)).toEqual(first);
    expect(harnessNextSeq("owned")).toBe(2);
    // A new commit with the same writes is a new append.
    expect((await connection.commitStorage({ ...commit, commitId: "commit-2" })).firstSeq).toBe(2);
    expect(harnessNextSeq("owned")).toBe(3);
  } finally { link.stop(); teardownTestDb(); }
});

test("a commit Pi refuses on the server is a definite rejection that changes nothing", async () => {
  setupTestDb();
  const { connection, link } = storageConnection();
  try {
    const project = createProject("Conflict", "/tmp/conflict");
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id });
    const storage = new RemoteStorage("owned", connection);
    await storage.commit([insertEntry({ id: "root", parentId: null, type: "custom", customType: "note" })], BACKGROUND_CONTEXT);

    // A stale writer re-sending an applied entry.
    await expect(storage.commit([setValue(value("pi.branch.tip", "main"), "root"), insertEntry({ id: "root", parentId: null, type: "custom", customType: "note" })], BACKGROUND_CONTEXT))
      .rejects.toMatchObject({ code: APPLICATION_ERROR, data: { code: "invalid_request", message: "Duplicate entry or usage id: root", retryable: false } });
    expect(harnessNextSeq("owned")).toBe(2);
    expect(await storage.getValue(value("pi.branch.tip", "main"), BACKGROUND_CONTEXT)).toBeUndefined();
  } finally { link.stop(); teardownTestDb(); }
});

test("a read result larger than the link's frame cap arrives whole", async () => {
  setupTestDb();
  const { connection, link } = storageConnection({ maxFrameBytes: SMALL_FRAME_BYTES });
  try {
    const project = createProject("Large read", "/tmp/large-read");
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id });
    await new PiStorageAdapter(getDb(), "owned").commit([setValue(value("notes", "a"), large("a")), setValue(value("notes", "b"), large("b"))], BACKGROUND_CONTEXT);

    const storage = new RemoteStorage("owned", connection);
    expect(await storage.scanValues(value("notes", ""), BACKGROUND_CONTEXT)).toEqual([
      { address: value("notes", "a"), value: large("a"), seq: 1 },
      { address: value("notes", "b"), value: large("b"), seq: 2 },
    ]);
    // Small results still cross in one reply.
    expect(await storage.getStats(BACKGROUND_CONTEXT)).toMatchObject({ messageCount: 0 });
  } finally { link.stop(); teardownTestDb(); }
});

test("a commit larger than the link's frame cap is applied once, whole", async () => {
  setupTestDb();
  const { connection, link } = storageConnection({ maxFrameBytes: SMALL_FRAME_BYTES });
  try {
    const project = createProject("Large commit", "/tmp/large-commit");
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id });
    const storage = new RemoteStorage("owned", connection);

    expect(await storage.commit([appendList(list("frames", "op"), large("first")), setValue(value("notes", "a"), large("a"))], BACKGROUND_CONTEXT))
      .toMatchObject({ firstSeq: 1, seqs: [1, 2] });
    expect(harnessNextSeq("owned")).toBe(3);
    const server = new PiStorageAdapter(getDb(), "owned");
    expect(await server.readList(list("frames", "op"), undefined, BACKGROUND_CONTEXT)).toEqual([{ seq: 1, value: large("first") }]);
    expect(await server.getValue(value("notes", "a"), BACKGROUND_CONTEXT)).toEqual({ address: value("notes", "a"), value: large("a"), seq: 2 });
  } finally { link.stop(); teardownTestDb(); }
});

test("a large commit whose reply was lost is resent on the next connection and answered from its record, applied once", async () => {
  setupTestDb();
  // The first connection applies the commit, then closes instead of sending its result.
  const dropping = storageConnection({ maxFrameBytes: SMALL_FRAME_BYTES, serverSocket: end => {
    const send = end.send.bind(end);
    end.send = data => { if (typeof data === "string" && JSON.parse(data).result?.firstSeq !== undefined) end.close(); else send(data); };
    return end;
  } });
  const next = storageConnection({ maxFrameBytes: SMALL_FRAME_BYTES });
  try {
    const project = createProject("Lost reply", "/tmp/lost-reply");
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id });
    // A list append has no ID of its own: only the commit's ID tells the resend apart from a new append.
    const commit = { sessionId: "owned", commitId: "commit-1", writes: [{ kind: "list" as const, op: "append" as const, namespace: "frames", key: "op", value: large("frame") }] };
    await expect(dropping.connection.commitStorage(commit)).rejects.toMatchObject({ outcome: "unknown" });
    expect(harnessNextSeq("owned")).toBe(2);

    expect(await next.connection.commitStorage(commit)).toMatchObject({ firstSeq: 1, seqs: [1] });
    expect(harnessNextSeq("owned")).toBe(2);
    expect(await new PiStorageAdapter(getDb(), "owned").readList(list("frames", "op"), undefined, BACKGROUND_CONTEXT)).toEqual([{ seq: 1, value: large("frame") }]);
  } finally { dropping.link.stop(); next.link.stop(); teardownTestDb(); }
});
