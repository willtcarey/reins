import { expect, test } from "bun:test";
import { AgentHarness, BACKGROUND_CONTEXT, StorageBackedSession } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { piDb } from "./test-db.js";
import { PiStorageAdapter } from "./pi-storage.js";
import { createMainLane, MAIN_LANE, piThinkingLevel, storedLaneModel } from "./lane.js";

function fauxModels() {
  const faux = fauxProvider({ provider: "lane-faux", models: [{ id: "fake" }, { id: "other" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: (id: string) => faux.getModel(id)! };
}

const seed = { sessionId: "s", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/tmp/lane", parentSessionId: null };

test("Pi creates the main lane seeded with the session's model, and a repeat writes nothing", async () => {
  const db = piDb("s");
  const { models, model } = fauxModels();
  const nextSeq = () => db.query("SELECT harness_next_seq FROM sessions WHERE id = 's'").get();
  try {
    expect(await storedLaneModel(new PiStorageAdapter(db, "s"))).toBeNull();
    await createMainLane(new PiStorageAdapter(db, "s"), { ...seed, models, model: model("fake"), thinkingLevel: "high" });
    const written = nextSeq();

    // Pi attaches the existing lane without writing, whatever a later harness is seeded with.
    await createMainLane(new PiStorageAdapter(db, "s"), { ...seed, models, model: model("other"), thinkingLevel: null });
    expect(nextSeq()).toEqual(written);
    expect(await storedLaneModel(new PiStorageAdapter(db, "s"))).toEqual({ provider: "lane-faux", modelId: "fake", thinkingLevel: "high" });

    // Read back through Pi's lane API.
    const session = new StorageBackedSession({ id: "s", createdAt: Date.parse(seed.createdAt), storageVersion: 1, cwd: seed.cwd }, new PiStorageAdapter(db, "s"));
    const { harness } = await AgentHarness.create({ session, models, model: model("other") }, BACKGROUND_CONTEXT);
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
