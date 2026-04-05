import { describe, test, expect } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { useTestRepo } from "./helpers/test-repo.js";
import { createServerState } from "./helpers/server-state.js";
import { createProject } from "../project-store.js";
import { getSession } from "../session-store.js";
import { setSetting, deleteSetting } from "../settings-store.js";
import { createNewSession, resolveConfiguredModel } from "../sessions.js";

describe("resolveConfiguredModel", () => {
  useTestDb();

  test("returns the configured default model from settings", () => {
    setSetting("default_model", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "medium",
    });

    const model = resolveConfiguredModel();

    expect(model?.provider).toBe("anthropic");
    expect(model?.id).toBe("claude-sonnet-4-20250514");
  });

  test("returns undefined when no default model is configured", () => {
    deleteSetting("default_model");

    expect(resolveConfiguredModel()).toBeUndefined();
  });

  test("ignores REINS_PROVIDER/REINS_MODEL env vars when no default model is configured", () => {
    deleteSetting("default_model");

    const prevProvider = process.env.REINS_PROVIDER;
    const prevModel = process.env.REINS_MODEL;

    try {
      process.env.REINS_PROVIDER = "anthropic";
      process.env.REINS_MODEL = "claude-sonnet-4-20250514";

      expect(resolveConfiguredModel()).toBeUndefined();
    } finally {
      if (prevProvider === undefined) delete process.env.REINS_PROVIDER;
      else process.env.REINS_PROVIDER = prevProvider;

      if (prevModel === undefined) delete process.env.REINS_MODEL;
      else process.env.REINS_MODEL = prevModel;
    }
  });
});

describe("createNewSession", () => {
  useTestDb();
  const repo = useTestRepo();

  test("applies the configured default thinking level to new sessions", async () => {
    deleteSetting("default_model");

    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");

    const baseline = await createNewSession(state, project.id, repo.dir);
    expect(baseline.session.model).not.toBeNull();

    const configuredThinkingLevel = baseline.session.thinkingLevel === "medium" ? "high" : "medium";

    setSetting("default_model", {
      provider: baseline.session.model!.provider,
      modelId: baseline.session.model!.id,
      thinkingLevel: configuredThinkingLevel,
    });

    const managed = await createNewSession(state, project.id, repo.dir);

    expect(managed.session.thinkingLevel).toBe(configuredThinkingLevel);
    expect(getSession(managed.id)?.thinking_level).toBe(configuredThinkingLevel);
  });
});
