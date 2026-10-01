import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { insertEntry } from "@earendil-works/pi-agent-core/harness/session";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { RemoteStorage } from "@reins/node/remote-storage";
import { APPLICATION_ERROR, createNodeConnection, protocolVersion } from "@reins/node-protocol";
import { scriptedCommandHandlers } from "@reins/node-protocol/testing";
import { getDb } from "../../db.js";
import { createSource, defaultSource } from "../../node-store.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { dialLoopback, SEEDED_NODE_ID } from "../helpers/loopback-node.js";
import { createServerState } from "../helpers/server-state.js";
import { setupTestDb, teardownTestDb } from "../helpers/test-db.js";

/** A node end that only calls the server, connected through the hub's real `accept` as `nodeId`. */
function storageConnection(nodeId = SEEDED_NODE_ID) {
  let connection!: ReturnType<typeof createNodeConnection>;
  const link = dialLoopback(createServerState(), socket => (connection = createNodeConnection(socket, {
    nodeId, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], liveSessions: [], maxFrameBytes: Infinity, ...scriptedCommandHandlers({}),
  })), { redial: false });
  return { connection, link };
}

const harnessNextSeq = (sessionId: string) => getDb().query<{ harness_next_seq: number }, [string]>("SELECT harness_next_seq FROM sessions WHERE id = ?").get(sessionId)?.harness_next_seq;

// Pi's own Storage contract, met by the server's canonical storage as the node reaches it over the link.
for (const testCase of createStorageConformance(async () => {
  setupTestDb();
  const project = createProject("Remote storage", "/tmp/remote-storage");
  createSession("session", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id });
  const { connection, link } = storageConnection();
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
