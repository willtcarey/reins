import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { bindNodeSession, openNodeStorage } from "./storage.js";

test("Pi commits locally before async delivery and retries pending writes after server acknowledgement failure", async () => {
  const db = new Database(":memory:");
  bindNodeSession(db, "s", { sourceId: 1, cwd: "/tmp/node", createdAt: "2026-01-01", parentSessionId: null });
  let ack!: () => void;
  const storage = await openNodeStorage(db, "s", async () => new Promise<void>(resolve => { ack = resolve; }));
  const committed = storage.commit([setValue(value("test", "key"), "durable")], BACKGROUND_CONTEXT);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(db.query("SELECT start_seq FROM pending_commits").all()).toEqual([{ start_seq: 1 }]);
  expect(db.query("SELECT value_json FROM pi_values").get()).toEqual({ value_json: '"durable"' });
  ack();
  await committed;
  expect(db.query("SELECT * FROM pending_commits").all()).toEqual([]);
  await storage.close(BACKGROUND_CONTEXT);

  const offline = await openNodeStorage(db, "s", async () => { throw new Error("offline"); });
  await offline.commit([setValue(value("test", "key"), "offline")], BACKGROUND_CONTEXT);
  expect(db.query("SELECT start_seq FROM pending_commits").all()).toEqual([{ start_seq: 2 }]);
  await offline.close(BACKGROUND_CONTEXT);
  const restored = await openNodeStorage(db, "s", async () => {});
  expect(db.query("SELECT * FROM pending_commits").all()).toEqual([]);
  expect((await restored.getValue(value("test", "key"), BACKGROUND_CONTEXT))?.value).toBe("offline");
  await restored.close(BACKGROUND_CONTEXT);
  db.close();
});
