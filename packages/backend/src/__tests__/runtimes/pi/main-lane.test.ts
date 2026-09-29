import { describe, expect, test } from "bun:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { PiStorageAdapter } from "@reins/pi-sql-storage";
import { storedLaneModel } from "@reins/pi-sql-storage/lane";
import { getDb } from "../../../db.js";
import { createProject } from "../../../project-store.js";
import { setSetting } from "../../../settings-store.js";
import { ensureMainLane } from "../../../runtimes/pi/main-lane.js";
import { createSession } from "../../session-fixture.js";
import { useTestDb } from "../../helpers/test-db.js";
import { registerPiProvider, unregisterPiProvider } from "../../helpers/pi-providers.js";

describe("server main lane", () => {
  useTestDb();
  const harnessNextSeq = (sessionId: string) => getDb().query("SELECT harness_next_seq FROM sessions WHERE id = ?").get(sessionId);

  test("is created once in the server database with the session's model, and a second call writes nothing", async () => {
    const provider = fauxProvider({ provider: "server-lane-faux", models: [{ id: "fake" }] });
    registerPiProvider(provider.provider);
    try {
      const project = createProject("Server lane", "/tmp/server-lane");
      createSession("s", project.id, { agentRuntimeType: "pi", modelProvider: "server-lane-faux", modelId: "fake", thinkingLevel: "high" });

      expect(await ensureMainLane(getDb(), "s")).toBe(true);
      const written = harnessNextSeq("s");
      expect(await ensureMainLane(getDb(), "s")).toBe(true);

      expect(harnessNextSeq("s")).toEqual(written);
      expect(await storedLaneModel(new PiStorageAdapter(getDb(), "s"))).toEqual({ provider: "server-lane-faux", modelId: "fake", thinkingLevel: "high" });
    } finally { unregisterPiProvider(provider.provider.id); }
  });

  test("falls back to the default model and its thinking level for a session without one", async () => {
    const provider = fauxProvider({ provider: "server-lane-default", models: [{ id: "fake" }] });
    registerPiProvider(provider.provider);
    try {
      setSetting("default_model", { provider: "server-lane-default", modelId: "fake", runtimeType: "pi", thinkingLevel: "low" });
      const project = createProject("Server lane", "/tmp/server-lane");
      createSession("s", project.id, { agentRuntimeType: "pi" });

      expect(await ensureMainLane(getDb(), "s")).toBe(true);

      expect(await storedLaneModel(new PiStorageAdapter(getDb(), "s"))).toEqual({ provider: "server-lane-default", modelId: "fake", thinkingLevel: "low" });
    } finally { unregisterPiProvider(provider.provider.id); }
  });

  test("is not created when no model resolves", async () => {
    const project = createProject("Server lane", "/tmp/server-lane");
    createSession("s", project.id, { agentRuntimeType: "pi" });

    expect(await ensureMainLane(getDb(), "s")).toBe(false);

    expect(getDb().query("SELECT namespace FROM pi_values WHERE session_id = 's'").all()).toEqual([]);
  });

  test("with a model the server does not know fails and writes nothing", async () => {
    const project = createProject("Server lane", "/tmp/server-lane");
    createSession("s", project.id, { agentRuntimeType: "pi", modelProvider: "anthropic", modelId: "does-not-exist" });

    await expect(ensureMainLane(getDb(), "s")).rejects.toThrow("Model not found: anthropic/does-not-exist");

    expect(getDb().query("SELECT namespace FROM pi_values WHERE session_id = 's'").all()).toEqual([]);
  });
});
