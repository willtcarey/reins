import { expect, test } from "bun:test";
import { AgentHarness, BACKGROUND_CONTEXT, StorageBackedSession } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { piDb } from "./test-db.js";
import { PiStorageAdapter } from "./pi-storage.js";
import { MAIN_LANE, piThinkingLevel, storedLaneModel } from "./lane.js";

function fauxModels() {
  const faux = fauxProvider({ provider: "lane-faux", models: [{ id: "fake" }, { id: "other" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: (id: string) => faux.getModel(id)! };
}

/** Opens the session's main lane through Pi, which creates it seeded with `model` if it does not exist. */
async function openLane(db: ReturnType<typeof piDb>, models: ReturnType<typeof fauxModels>["models"], model: ReturnType<ReturnType<typeof fauxModels>["model"]>, thinkingLevel: "off" | "high") {
  const session = new StorageBackedSession({ id: "s", createdAt: Date.parse("2026-01-01T00:00:00.000Z"), storageVersion: 1, cwd: "/tmp/lane" }, new PiStorageAdapter(db, "s"));
  const { harness } = await AgentHarness.create({ session, models, model, thinkingLevel }, BACKGROUND_CONTEXT);
  try {
    const lane = await harness.lane(MAIN_LANE, BACKGROUND_CONTEXT);
    return { model: (await lane.getModel(BACKGROUND_CONTEXT))?.id, thinkingLevel: await lane.getThinkingLevel(BACKGROUND_CONTEXT) };
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}

test("the stored lane model is read before any harness opens: none until Pi creates the lane, then its seed", async () => {
  const db = piDb("s");
  const { models, model } = fauxModels();
  try {
    expect(await storedLaneModel(new PiStorageAdapter(db, "s"))).toBeNull();
    expect(await openLane(db, models, model("fake"), "high")).toEqual({ model: "fake", thinkingLevel: "high" });
    expect(await storedLaneModel(new PiStorageAdapter(db, "s"))).toEqual({ provider: "lane-faux", modelId: "fake", thinkingLevel: "high" });
    // An existing lane keeps its selection whatever a later harness is seeded with.
    expect(await openLane(db, models, model("other"), "off")).toEqual({ model: "fake", thinkingLevel: "high" });
    expect(await storedLaneModel(new PiStorageAdapter(db, "s"))).toEqual({ provider: "lane-faux", modelId: "fake", thinkingLevel: "high" });
  } finally { db.close(); }
});

test("contract thinking levels map to Pi's lane levels, null meaning off", () => {
  expect(piThinkingLevel(null)).toBe("off");
  expect(piThinkingLevel("xhigh")).toBe("xhigh");
  expect(() => piThinkingLevel("extreme")).toThrow("Invalid thinking level: extreme");
});
