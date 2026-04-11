import { describe, test, expect } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { useTestRepo } from "./helpers/test-repo.js";
import { createServerState } from "./helpers/server-state.js";
import { createProject } from "../project-store.js";
import { createSession, getSession } from "../session-store.js";
import { setSetting, deleteSetting } from "../settings-store.js";
import { createNewSession, ensureSessionOpen } from "../runtimes/sessions-manager.js";
import { resolveModelSetting } from "../models/model-settings.js";
import { getPiSession } from "../runtimes/pi/runtime.js";

describe("resolveModelSetting(default_model)", () => {
  useTestDb();

  test("returns the configured default model from settings", () => {
    setSetting("default_model", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "medium",
    });

    const model = resolveModelSetting("default_model");

    expect(model?.provider).toBe("anthropic");
    expect(model?.id).toBe("claude-sonnet-4-20250514");
  });

  test("returns undefined when no default model is configured", () => {
    deleteSetting("default_model");

    expect(resolveModelSetting("default_model")).toBeUndefined();
  });

  test("throws when a configured default model cannot be resolved", () => {
    setSetting("default_model", {
      provider: "anthropic",
      modelId: "does-not-exist",
      thinkingLevel: "medium",
    });

    expect(() => resolveModelSetting("default_model")).toThrow(/Configured default_model is invalid/);
  });

  test("ignores REINS_PROVIDER/REINS_MODEL env vars when no default model is configured", () => {
    deleteSetting("default_model");

    const prevProvider = process.env.REINS_PROVIDER;
    const prevModel = process.env.REINS_MODEL;

    try {
      process.env.REINS_PROVIDER = "anthropic";
      process.env.REINS_MODEL = "claude-sonnet-4-20250514";

      expect(resolveModelSetting("default_model")).toBeUndefined();
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
    const baselineSession = getPiSession(baseline.runtime);
    expect(baselineSession.model).not.toBeNull();

    const configuredThinkingLevel = baselineSession.thinkingLevel === "medium" ? "high" : "medium";

    setSetting("default_model", {
      provider: baselineSession.model!.provider,
      modelId: baselineSession.model!.id,
      thinkingLevel: configuredThinkingLevel,
    });

    const managed = await createNewSession(state, project.id, repo.dir);

    expect(getPiSession(managed.runtime).thinkingLevel).toBe(configuredThinkingLevel);
    expect(getSession(managed.id)?.thinking_level).toBe(configuredThinkingLevel);
  });

  test("throws when the configured default model cannot be resolved", async () => {
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");

    setSetting("default_model", {
      provider: "anthropic",
      modelId: "does-not-exist",
      thinkingLevel: "high",
    });

    await expect(createNewSession(state, project.id, repo.dir)).rejects.toThrow(
      /Configured default_model is invalid/,
    );
  });

  test("applies explicit model and thinking overrides when creating a session", async () => {
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");

    const managed = await createNewSession(state, project.id, repo.dir, {
      model: {
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
      thinkingLevel: "minimal",
    });

    expect(getPiSession(managed.runtime).model?.provider).toBe("anthropic");
    expect(getPiSession(managed.runtime).model?.id).toBe("claude-haiku-4-5");
    expect(getPiSession(managed.runtime).thinkingLevel).toBe("minimal");
    expect(getSession(managed.id)?.model_provider).toBe("anthropic");
    expect(getSession(managed.id)?.model_id).toBe("claude-haiku-4-5");
    expect(getSession(managed.id)?.thinking_level).toBe("minimal");
  });

});

describe("resumeSession", () => {
  useTestDb();
  const repo = useTestRepo();

  test("uses the persisted session model and thinking level instead of the current default", async () => {
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");

    createSession("resume-model-test", project.id, {
       agentRuntimeType: "pi",modelProvider: "anthropic",
      modelId: "claude-haiku-4-5",
      thinkingLevel: "minimal",
    });

    setSetting("default_model", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "high",
    });

    const managed = await ensureSessionOpen(state, "resume-model-test");

    expect(getPiSession(managed.runtime).model?.provider).toBe("anthropic");
    expect(getPiSession(managed.runtime).model?.id).toBe("claude-haiku-4-5");
    expect(getPiSession(managed.runtime).thinkingLevel).toBe("minimal");
  });

  test("throws when a resumed session needs an invalid configured default model", async () => {
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");

    createSession("resume-invalid-default", project.id, {
       agentRuntimeType: "pi",thinkingLevel: "off",
    });

    setSetting("default_model", {
      provider: "anthropic",
      modelId: "does-not-exist",
      thinkingLevel: "high",
    });

    await expect(
      ensureSessionOpen(state, "resume-invalid-default"),
    ).rejects.toThrow(
      /Configured default_model is invalid/,
    );
  });

  test("throws a generic invalid model error when a resumed session has an invalid persisted model", async () => {
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");

    createSession("resume-invalid-persisted-model", project.id, {
       agentRuntimeType: "pi",modelProvider: "claude-agent-sdk",
      modelId: "does-not-exist",
      thinkingLevel: "high",
    });

    await expect(
      ensureSessionOpen(state, "resume-invalid-persisted-model"),
    ).rejects.toThrow(
      /Selected session model is invalid/,
    );
  });

  test("preserves a persisted non-minimal thinking level when resuming even when the global default is also high", async () => {
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");

    createSession("resume-thinking-test", project.id, {
       agentRuntimeType: "pi",modelProvider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "high",
    });

    setSetting("default_model", {
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      thinkingLevel: "high",
    });

    const managed = await ensureSessionOpen(state, "resume-thinking-test");

    expect(getPiSession(managed.runtime).model?.provider).toBe("anthropic");
    expect(getPiSession(managed.runtime).model?.id).toBe("claude-sonnet-4-20250514");
    expect(getPiSession(managed.runtime).thinkingLevel).toBe("high");
  });
});
