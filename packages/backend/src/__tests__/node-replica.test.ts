import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../migrations.js";
import { resetDb, setDb } from "../db.js";
import { getSession } from "../session-store.js";
import { nodeSessionReports } from "../runtimes/node-session-events.js";
import { dispatcherFor } from "../models/node-command-dispatcher.js";
import { createServerState } from "./helpers/server-state.js";
import { BACKGROUND_CONTEXT, setValue, value, appendList, list } from "@earendil-works/pi-agent-core";
import { insertEntry, insertUsage } from "@earendil-works/pi-agent-core/harness/session";
import { getDb } from "../db.js";
import { createProject } from "../project-store.js";
import { createSession } from "./session-fixture.js";
import { setupTestDb, teardownTestDb } from "./helpers/test-db.js";
import { applyNodeReplica, latestNodeSettlement } from "../node-replica.js";
import { bindNodeSession, createOutboxDrain, openNodeDb, openNodeStorage, type NodeOutboxItem } from "@reins/node/storage";

test("node commits retain exact entries, values and lists across delivery and reopen", async () => {
  setupTestDb();
  const node = openNodeDb(":memory:");
  try {
    const project = createProject("Node", "/tmp/node");
    createSession("node-session", project.id, { agentRuntimeType: "pi" });
    bindNodeSession(node, "node-session", { sourceId: 1, cwd: "/tmp/node", createdAt: "2026-01-01", parentSessionId: null });
    const deliver = (id: string, item: NodeOutboxItem) => { if (item.kind === "committed") applyNodeReplica(getDb(), id, item.startSeq, item.payload); };
    const drain = createOutboxDrain(node, deliver);
    const storage = await openNodeStorage(node, "node-session", drain, () => 42);
    await storage.commit([
      insertEntry({ id: "root", parentId: null, type: "custom", customType: "note", data: { exact: true } }),
      insertEntry({ id: "child", parentId: "root", type: "custom", customType: "note" }),
      setValue(value("pi.branch.tip", "main"), "child"),
      appendList(list("test", "items"), { exact: true }),
      insertUsage({ id: "usage-1", entryId: "child", adjustment: false, usage: {
        input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      } }),
    ], BACKGROUND_CONTEXT);
    await storage.close(BACKGROUND_CONTEXT);
    expect(getDb().query<{ harness_id: string; seq: number }, []>("SELECT harness_id, seq FROM session_messages ORDER BY seq").all()).toEqual([
      { harness_id: "root", seq: 1 }, { harness_id: "child", seq: 2 },
    ]);
    const reopened = await openNodeStorage(node, "node-session", drain, () => 99);
    expect((await reopened.scanBranch({ start: "child" }, BACKGROUND_CONTEXT)).map(e => e.id)).toEqual(["child", "root"]);
    expect(await reopened.getValue(value("pi.branch.tip", "main"), BACKGROUND_CONTEXT)).toMatchObject({ value: "child", seq: 3 });
    expect(await reopened.readList(list("test", "items"), undefined, BACKGROUND_CONTEXT)).toEqual([{ seq: 4, value: { exact: true } }]);
    expect(getDb().query<{ value_json: string }, []>("SELECT value_json FROM pi_values").get()?.value_json).toBe('"child"');
    expect(getDb().query<{ id: string; seq: number }, []>("SELECT id,seq FROM pi_usage").get()).toEqual({ id: "usage-1", seq: 5 });
    await reopened.close(BACKGROUND_CONTEXT);
    await drain("node-session");
    expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) count FROM session_messages").get()?.count).toBe(2);
  } finally { node.close(); teardownTestDb(); }
});

test("failed replica delivery leaves a durable batch and replay acknowledges it exactly once", async () => {
  setupTestDb();
  const node = openNodeDb(":memory:");
  try {
    const project = createProject("Failure", "/tmp/failure");
    createSession("node-session", project.id, { agentRuntimeType: "pi" });
    bindNodeSession(node, "node-session", { sourceId: 1, cwd: "/tmp/failure", createdAt: "2026-01-01", parentSessionId: null });
    const server = getDb();
    const deliver = (id: string, item: NodeOutboxItem) => { if (item.kind === "committed") applyNodeReplica(server, id, item.startSeq, item.payload); };
    const drain = createOutboxDrain(node, deliver);
    server.exec("CREATE TRIGGER stop_replica BEFORE INSERT ON session_messages BEGIN SELECT RAISE(ABORT, 'offline'); END");
    const storage = await openNodeStorage(node, "node-session", drain, () => 42);
    await storage.commit([insertEntry({ id: "root", parentId: null, type: "custom", customType: "note" })], BACKGROUND_CONTEXT);
    expect(node.query<{ count: number }, []>("SELECT COUNT(*) count FROM session_outbox").get()?.count).toBe(1);
    expect(server.query<{ count: number }, []>("SELECT COUNT(*) count FROM session_messages").get()?.count).toBe(0);
    server.exec("DROP TRIGGER stop_replica");
    const reopened = await openNodeStorage(node, "node-session", drain);
    expect((await reopened.scanBranch({ start: "root" }, BACKGROUND_CONTEXT)).map(e => e.id)).toEqual(["root"]);
    await reopened.close(BACKGROUND_CONTEXT);
    await drain("node-session");
    expect(server.query<{ count: number }, []>("SELECT COUNT(*) count FROM session_messages").get()?.count).toBe(1);
    await storage.close(BACKGROUND_CONTEXT);
  } finally { node.close(); teardownTestDb(); }
});

/** A file-backed server database, so a test can restart the server: a fresh connection with no memory. */
function serverDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "reins-server-restart-"));
  const path = join(dir, "reins.db");
  const open = () => {
    const db = new Database(path);
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setDb(db);
    return db;
  };
  let db = open();
  return {
    get db() { return db; },
    restart() { resetDb(); db.close(); db = open(); return db; },
    dispose() { resetDb(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("replica batches are applied by sequence watermark: after a server restart, replays are acknowledged without applying, a gap is rejected and a divergent replay of the last batch is detected", async () => {
  const server = serverDatabase();
  const node = openNodeDb(":memory:");
  try {
    const project = createProject("Watermark", "/tmp/watermark");
    createSession("n", project.id, { agentRuntimeType: "pi" });
    bindNodeSession(node, "n", { sourceId: 1, cwd: "/tmp/watermark", createdAt: "2026-01-01", parentSessionId: null });
    // The node's batches, as its outbox delivers them (not applied yet).
    const batches: Array<{ startSeq: number; payload: string }> = [];
    const storage = await openNodeStorage(node, "n", createOutboxDrain(node, (_id: string, item: NodeOutboxItem) => { if (item.kind === "committed") batches.push(item); }), () => 42);
    await storage.commit([insertEntry({ id: "a1", parentId: null, type: "custom", customType: "note" }), insertEntry({ id: "a2", parentId: "a1", type: "custom", customType: "note" })], BACKGROUND_CONTEXT);
    await storage.commit([insertEntry({ id: "b", parentId: "a2", type: "custom", customType: "note" })], BACKGROUND_CONTEXT);
    await storage.commit([insertEntry({ id: "c", parentId: "b", type: "custom", customType: "note" })], BACKGROUND_CONTEXT);
    await storage.commit([insertEntry({ id: "d", parentId: "c", type: "custom", customType: "note" })], BACKGROUND_CONTEXT);
    await storage.close(BACKGROUND_CONTEXT);
    expect(batches.map(batch => batch.startSeq)).toEqual([1, 3, 4, 5]);
    const [a, b, c, d] = [0, 1, 2, 3].map(index => batches[index]!);
    applyNodeReplica(server.db, "n", a.startSeq, a.payload);
    applyNodeReplica(server.db, "n", b.startSeq, b.payload);

    const db = server.restart();
    const replica = () => ({
      rows: db.query("SELECT seq, harness_id FROM session_messages WHERE session_id = 'n' ORDER BY seq").all(),
      next: db.query("SELECT harness_next_seq FROM sessions WHERE id = 'n'").get(),
    });
    const applied = replica();
    expect(applied).toEqual({ rows: [{ seq: 1, harness_id: "a1" }, { seq: 2, harness_id: "a2" }, { seq: 3, harness_id: "b" }], next: { harness_next_seq: 4 } });
    // Replays below the watermark (the last batch, compared by hash, and an older one) apply nothing.
    applyNodeReplica(db, "n", b.startSeq, b.payload);
    applyNodeReplica(db, "n", a.startSeq, a.payload);
    expect(replica()).toEqual(applied);
    // A different string for the last batch is divergence.
    expect(() => applyNodeReplica(db, "n", b.startSeq, JSON.stringify(JSON.parse(b.payload), null, 2))).toThrow("Replica divergence: n");
    // A batch past the watermark is a gap: rejected, so it stays pending on the node.
    expect(() => applyNodeReplica(db, "n", d.startSeq, d.payload)).toThrow("Replica gap: n expects seq 4, got 5");
    // A batch straddling the watermark cannot come from the node's history.
    const straddling = JSON.stringify([...JSON.parse(b.payload), ...JSON.parse(c.payload)]);
    expect(() => applyNodeReplica(db, "n", b.startSeq, straddling)).toThrow("Replica divergence: n batch at 3 overlaps seq 4");
    expect(replica()).toEqual(applied);
    // Continuing at the watermark applies in order.
    applyNodeReplica(db, "n", c.startSeq, c.payload);
    applyNodeReplica(db, "n", d.startSeq, d.payload);
    expect(replica().next).toEqual({ harness_next_seq: 6 });
  } finally { node.close(); server.dispose(); }
});

test("a replayed lifecycle report after a server restart applies nothing: no second parent steer or state change; a divergent payload is rejected", () => {
  const server = serverDatabase();
  let state = createServerState(undefined, { loopbackNode: false });
  try {
    const project = createProject("Lifecycle restart", "/tmp/lifecycle-restart");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent", placementStatus: "provisioned" });
    const steers = () => server.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM node_command_outbox WHERE session_id = 'parent' AND json_extract(command_json, '$.op') = 'session.steer'").get()!.n;
    const settled = { sessionId: "child", runId: "r1", status: "completed" as const, metadata: { model: null, thinkingLevel: null },
      reply: { text: "Done", stopReason: "stop", errorMessage: null } };
    nodeSessionReports(state).started({ sessionId: "child", runId: "r1" });
    expect(getSession("child")?.activity_state).toBe("running");
    nodeSessionReports(state).settled(settled);
    expect(steers()).toBe(1);
    expect(getSession("child")?.activity_state).toBeNull();
    expect(latestNodeSettlement(server.db, "child")).toEqual({ seq: 1, nextSeq: 1, status: "completed" });

    // The acknowledgement was lost and the server restarted: the node replays the settlement.
    dispatcherFor(state).stop();
    server.restart();
    state = createServerState(undefined, { loopbackNode: false });
    const updated = getSession("child")!.updated_at;
    nodeSessionReports(state).settled(settled);
    // Pi re-reports `started` for a run that already settled (a resumed run): also already applied.
    nodeSessionReports(state).started({ sessionId: "child", runId: "r1" });
    expect(steers()).toBe(1);
    expect(getSession("child")).toMatchObject({ activity_state: null, updated_at: updated });
    expect(latestNodeSettlement(server.db, "child")).toEqual({ seq: 1, nextSeq: 1, status: "completed" });
    // The same report with a different payload is divergence: rejected with no effects.
    expect(() => nodeSessionReports(state).settled({ ...settled, status: "failed", error: { message: "rewritten" } })).toThrow("Lifecycle divergence: child settled r1");
    expect(steers()).toBe(1);
    expect(latestNodeSettlement(server.db, "child")).toEqual({ seq: 1, nextSeq: 1, status: "completed" });
    // The next run applies.
    nodeSessionReports(state).started({ sessionId: "child", runId: "r2" });
    expect(getSession("child")?.activity_state).toBe("running");
  } finally { dispatcherFor(state).stop(); server.dispose(); }
});
