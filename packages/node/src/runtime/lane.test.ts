import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { openNodeStorage, provisionNodeSession, createOutboxDrain } from "../storage.js";
import { runNodeMigrations } from "../migrations.js";
import { createMainLane, storedLaneModel } from "./lane.js";

const binding = { sourceId: 7, cwd: "/tmp/node-lane", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
const offline = async () => { throw new Error("offline"); };

test("Pi creates the main lane through the node's storage as a commit recorded for replication to the server", async () => {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  const faux = fauxProvider({ provider: "lane-faux", models: [{ id: "fake" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  try {
    provisionNodeSession(db, "s", binding, null);
    await createMainLane(await openNodeStorage(db, "s", createOutboxDrain(db, offline)), "s", binding, models, faux.getModel("fake")!, "high");
    expect(db.query("SELECT kind, start_seq FROM session_outbox WHERE session_id = 's'").all()).toEqual([{ kind: "committed", start_seq: 1 }]);
    expect(await storedLaneModel(await openNodeStorage(db, "s", createOutboxDrain(db, offline)))).toEqual({ provider: "lane-faux", modelId: "fake", thinkingLevel: "high" });
  } finally { db.close(); }
});
