import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, setValue, value, appendList, list } from "@earendil-works/pi-agent-core";
import { insertEntry, insertUsage } from "@earendil-works/pi-agent-core/harness/session";
import { getDb } from "../../../db.js";
import { createProject } from "../../../project-store.js";
import { createSession } from "../../session-fixture.js";
import { setupTestDb, teardownTestDb } from "../../helpers/test-db.js";
import { openNodeStorage, deliverNodeCommits } from "../../../runtimes/pi/node-storage.js";
import { bindNodeSession, initializeNodeStorage, nodeStoragePath } from "@reins/node/storage";
import { homedir } from "node:os";
import { join } from "node:path";

test("internal node storage uses the user's node directory, independent of the server data directory", () => {
  expect(nodeStoragePath()).toBe(join(homedir(), ".reins", "node", "storage.db"));
  expect(nodeStoragePath("/tmp/home")).toBe("/tmp/home/.reins/node/storage.db");
});
import { PiStorageAdapter } from "../../../runtimes/pi/storage-adapter.js";

test("node commits retain exact entries, values and lists across delivery and reopen", async () => {
  setupTestDb();
  const node = new Database(":memory:");
  initializeNodeStorage(node);
  try {
    const project = createProject("Node", "/tmp/node");
    createSession("node-session", project.id, { agentRuntimeType: "pi" });
    bindNodeSession(node, "node-session", { sourceId: 1, cwd: "/tmp/node", createdAt: "2026-01-01", parentSessionId: null });
    const storage = await openNodeStorage(node, getDb(), "node-session", () => 42);
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
    const reopened = await openNodeStorage(node, getDb(), "node-session", () => 99);
    expect((await reopened.scanBranch({ start: "child" }, BACKGROUND_CONTEXT)).map(e => e.id)).toEqual(["child", "root"]);
    expect(await reopened.getValue(value("pi.branch.tip", "main"), BACKGROUND_CONTEXT)).toMatchObject({ value: "child", seq: 3 });
    expect(await reopened.readList(list("test", "items"), undefined, BACKGROUND_CONTEXT)).toEqual([{ seq: 4, value: { exact: true } }]);
    expect(getDb().query<{ value_json: string }, []>("SELECT value_json FROM pi_values").get()?.value_json).toBe('"child"');
    expect(getDb().query<{ id: string; seq: number }, []>("SELECT id,seq FROM pi_usage").get()).toEqual({ id: "usage-1", seq: 5 });
    await reopened.close(BACKGROUND_CONTEXT);
    await deliverNodeCommits(node, getDb(), "node-session");
    expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) count FROM session_messages").get()?.count).toBe(2);
  } finally { node.close(); teardownTestDb(); }
});

test("failed replica delivery leaves a durable batch and replay acknowledges it exactly once", async () => {
  setupTestDb();
  const node = new Database(":memory:");
  initializeNodeStorage(node);
  try {
    const project = createProject("Failure", "/tmp/failure");
    createSession("node-session", project.id, { agentRuntimeType: "pi" });
    bindNodeSession(node, "node-session", { sourceId: 1, cwd: "/tmp/failure", createdAt: "2026-01-01", parentSessionId: null });
    const server = getDb();
    server.query("UPDATE sessions SET storage_owner = 'internal-node' WHERE id = ?").run("node-session");
    await expect(new PiStorageAdapter(server, "node-session").commit([
      insertEntry({ id: "server-write", parentId: null, type: "custom", customType: "note" }),
    ], BACKGROUND_CONTEXT)).rejects.toThrow();
    server.exec("CREATE TRIGGER stop_replica BEFORE INSERT ON session_messages BEGIN SELECT RAISE(ABORT, 'offline'); END");
    const storage = await openNodeStorage(node, server, "node-session", () => 42);
    await storage.commit([insertEntry({ id: "root", parentId: null, type: "custom", customType: "note" })], BACKGROUND_CONTEXT);
    expect(node.query<{ count: number }, []>("SELECT COUNT(*) count FROM pending_commits").get()?.count).toBe(1);
    expect(server.query<{ count: number }, []>("SELECT COUNT(*) count FROM session_messages").get()?.count).toBe(0);
    server.exec("DROP TRIGGER stop_replica");
    const reopened = await openNodeStorage(node, server, "node-session");
    expect((await reopened.scanBranch({ start: "root" }, BACKGROUND_CONTEXT)).map(e => e.id)).toEqual(["root"]);
    await reopened.close(BACKGROUND_CONTEXT);
    await deliverNodeCommits(node, server, "node-session");
    expect(server.query<{ count: number }, []>("SELECT COUNT(*) count FROM session_messages").get()?.count).toBe(1);
    await storage.close(BACKGROUND_CONTEXT);
  } finally { node.close(); teardownTestDb(); }
});
