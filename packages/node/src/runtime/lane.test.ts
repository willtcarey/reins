import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AgentHarness, BACKGROUND_CONTEXT, StorageBackedSession } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { openNodeStorage, provisionNodeSession, createOutboxDrain } from "../storage.js";
import { runNodeMigrations } from "../migrations.js";
import { createMainLane, MAIN_LANE, piThinkingLevel, storedLaneModel } from "./lane.js";

const binding = { sourceId: 7, cwd: "/tmp/node-lane", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
const offline = async () => { throw new Error("offline"); };

test("Pi creates the main lane through the node's storage, seeded with the provisioned model, and a repeat writes nothing", async () => {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  const faux = fauxProvider({ provider: "lane-faux", models: [{ id: "fake" }, { id: "other" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const nextSeq = () => db.query("SELECT harness_next_seq FROM sessions WHERE id = 's'").get();
  try {
    provisionNodeSession(db, "s", binding, null);
    expect(await storedLaneModel(await openNodeStorage(db, "s", createOutboxDrain(db, offline)))).toBeNull();
    await createMainLane(await openNodeStorage(db, "s", createOutboxDrain(db, offline)), "s", binding, models, faux.getModel("fake")!, "high");
    // The lane is an ordinary Pi commit, recorded for replication to the server.
    expect(db.query("SELECT kind, start_seq FROM session_outbox WHERE session_id = 's'").all()).toEqual([{ kind: "committed", start_seq: 1 }]);
    const written = nextSeq();

    // Pi attaches the existing lane without writing, whatever a later harness is seeded with.
    await createMainLane(await openNodeStorage(db, "s", createOutboxDrain(db, offline)), "s", binding, models, faux.getModel("other")!, null);
    expect(nextSeq()).toEqual(written);
    expect(await storedLaneModel(await openNodeStorage(db, "s", createOutboxDrain(db, offline)))).toEqual({ provider: "lane-faux", modelId: "fake", thinkingLevel: "high" });

    // Read back through Pi's lane API.
    const session = new StorageBackedSession({ id: "s", createdAt: Date.parse(binding.createdAt), storageVersion: 1, cwd: binding.cwd }, await openNodeStorage(db, "s", createOutboxDrain(db, offline)));
    const { harness } = await AgentHarness.create({ session, models, model: faux.getModel("other")! }, BACKGROUND_CONTEXT);
    const lane = await harness.lane(MAIN_LANE, BACKGROUND_CONTEXT);
    expect((await lane.getModel(BACKGROUND_CONTEXT))?.id).toBe("fake");
    expect(await lane.getThinkingLevel(BACKGROUND_CONTEXT)).toBe("high");
    await harness.close(BACKGROUND_CONTEXT);
    expect(nextSeq()).toEqual(written);
  } finally { db.close(); }
});

test("contract thinking levels map to Pi's lane levels, null meaning off", () => {
  expect(piThinkingLevel(null)).toBe("off");
  expect(piThinkingLevel("xhigh")).toBe("xhigh");
  expect(() => piThinkingLevel("extreme")).toThrow("Invalid thinking level: extreme");
});
