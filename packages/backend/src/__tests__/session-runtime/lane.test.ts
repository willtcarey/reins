import { expect, test } from "bun:test";
import { AgentHarness, BACKGROUND_CONTEXT, StorageBackedSession } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { getDb } from "../../app-globals.js";
import { PiStorageAdapter } from "../../pi-storage.js";
import { MAIN_LANE, piThinkingLevel, storedLaneModel } from "../../session-runtime/lane.js";
import { createProject } from "../project-fixture.js";
import { createSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();

function fauxModels() {
  const faux = fauxProvider({ provider: "lane-faux", models: [{ id: "fake" }, { id: "other" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: (id: string) => faux.getModel(id)! };
}

/** Opens the session's main lane through Pi, which creates it seeded with `model` if it does not exist. */
async function openLane(models: ReturnType<typeof fauxModels>["models"], model: ReturnType<ReturnType<typeof fauxModels>["model"]>, thinkingLevel: "off" | "high") {
  const session = new StorageBackedSession({ id: "s", createdAt: Date.parse("2026-01-01T00:00:00.000Z"), storageVersion: 1, cwd: "/tmp/lane" }, new PiStorageAdapter(getDb(), "s"));
  const { harness } = await AgentHarness.create({ session, models, model, thinkingLevel }, BACKGROUND_CONTEXT);
  try {
    const lane = await harness.lane(MAIN_LANE, BACKGROUND_CONTEXT);
    return { model: (await lane.getModel(BACKGROUND_CONTEXT))?.id, thinkingLevel: await lane.getThinkingLevel(BACKGROUND_CONTEXT) };
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}

test("the stored lane model is read before any harness opens: none until Pi creates the lane, then its seed", async () => {
  createSession("s", createProject("Lane", "/tmp/lane").id, { agentRuntimeType: "pi" });
  const { models, model } = fauxModels();
  expect(await storedLaneModel(new PiStorageAdapter(getDb(), "s"))).toBeNull();
  expect(await openLane(models, model("fake"), "high")).toEqual({ model: "fake", thinkingLevel: "high" });
  expect(await storedLaneModel(new PiStorageAdapter(getDb(), "s"))).toEqual({ provider: "lane-faux", modelId: "fake", thinkingLevel: "high" });
  // An existing lane keeps its selection whatever a later harness is seeded with.
  expect(await openLane(models, model("other"), "off")).toEqual({ model: "fake", thinkingLevel: "high" });
  expect(await storedLaneModel(new PiStorageAdapter(getDb(), "s"))).toEqual({ provider: "lane-faux", modelId: "fake", thinkingLevel: "high" });
});

test("contract thinking levels map to Pi's lane levels, null meaning off", () => {
  expect(piThinkingLevel(null)).toBe("off");
  expect(piThinkingLevel("xhigh")).toBe("xhigh");
  expect(() => piThinkingLevel("extreme")).toThrow("Invalid thinking level: extreme");
});
