import { describe, test, expect } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { useTestRepo } from "./helpers/test-repo.js";
import { createServerState } from "./helpers/server-state.js";
import { createProject } from "../project-store.js";
import { createSession, getSession } from "../session-store.js";
import { setSetting, deleteSetting } from "../settings-store.js";
import { createNewSession, resumeSession } from "../pi/sessions.js";
import { resolveConfiguredModel } from "../pi/session-models.js";

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

  test("throws when a configured default model cannot be resolved", () => {
    setSetting("default_model", {
      provider: "anthropic",
      modelId: "does-not-exist",
      thinkingLevel: "medium",
    });

    expect(() => resolveConfiguredModel()).toThrow(/Configured default_model is invalid/);
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
      modelProvider: "anthropic",
      modelId: "claude-haiku-4-5",
      thinkingLevel: "minimal",
    });

    expect(managed.session.model?.provider).toBe("anthropic");
    expect(managed.session.model?.id).toBe("claude-haiku-4-5");
    expect(managed.session.thinkingLevel).toBe("minimal");
    expect(getSession(managed.id)?.model_provider).toBe("anthropic");
    expect(getSession(managed.id)?.model_id).toBe("claude-haiku-4-5");
    expect(getSession(managed.id)?.thinking_level).toBe("minimal");
  });

  test("rejects partial model overrides", async () => {
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");

    await expect(createNewSession(state, project.id, repo.dir, {
      modelProvider: "anthropic",
    })).rejects.toThrow(/Both modelProvider and modelId are required/);
  });
});

describe("resumeSession", () => {
  useTestDb();
  const repo = useTestRepo();

  test("uses the persisted session model and thinking level instead of the current default", async () => {
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");

    createSession("resume-model-test", project.id, {
      modelProvider: "anthropic",
      modelId: "claude-haiku-4-5",
      thinkingLevel: "minimal",
    });

    setSetting("default_model", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "high",
    });

    const managed = await resumeSession(state, "resume-model-test", repo.dir);

    expect(managed.session.model?.provider).toBe("anthropic");
    expect(managed.session.model?.id).toBe("claude-haiku-4-5");
    expect(managed.session.thinkingLevel).toBe("minimal");
  });

  test("throws when a resumed session needs an invalid configured default model", async () => {
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");

    createSession("resume-invalid-default", project.id, {
      thinkingLevel: "off",
    });

    setSetting("default_model", {
      provider: "anthropic",
      modelId: "does-not-exist",
      thinkingLevel: "high",
    });

    await expect(resumeSession(state, "resume-invalid-default", repo.dir)).rejects.toThrow(
      /Configured default_model is invalid/,
    );
  });

  test("throws when a resumed session has an invalid persisted model instead of silently falling back", async () => {
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");

    createSession("resume-invalid-persisted-model", project.id, {
      modelProvider: "claude-agent-sdk",
      modelId: "does-not-exist",
      thinkingLevel: "high",
    });

    await expect(resumeSession(state, "resume-invalid-persisted-model", repo.dir)).rejects.toThrow(
      /Persisted session model is invalid/,
    );
  });

  test("preserves a persisted non-minimal thinking level when resuming even when the global default is also high", async () => {
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");

    createSession("resume-thinking-test", project.id, {
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "high",
    });

    setSetting("default_model", {
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      thinkingLevel: "high",
    });

    const managed = await resumeSession(state, "resume-thinking-test", repo.dir);

    expect(managed.session.model?.provider).toBe("anthropic");
    expect(managed.session.model?.id).toBe("claude-sonnet-4-20250514");
    expect(managed.session.thinkingLevel).toBe("high");
  });
});
