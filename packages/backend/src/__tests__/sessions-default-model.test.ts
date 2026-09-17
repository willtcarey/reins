import { describe, test, expect } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { useTestRepo } from "./helpers/test-repo.js";
import { createServerState } from "./helpers/server-state.js";
import { createProject } from "../project-store.js";
import { createSession, getSession } from "../session-store.js";
import { setSetting, deleteSetting } from "../settings-store.js";
import { createNewSession, ensureSessionOpen } from "../runtimes/sessions-manager.js";
import { resolveModelSetting, resolveUtilityModel } from "../models/model-settings.js";

describe("resolveModelSetting(default_model)", () => {
  useTestDb();

  test("returns the configured default model from settings", () => {
    setSetting("default_model", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      runtimeType: "pi",
      thinkingLevel: "medium",
    });

    const model = resolveModelSetting("default_model");

    expect(model?.provider).toBe("anthropic");
    expect(model?.id).toBe("claude-sonnet-4-5");
  });

  test("returns undefined when no default model is configured", () => {
    deleteSetting("default_model");

    expect(resolveModelSetting("default_model")).toBeUndefined();
  });

  test("throws when a configured default model cannot be resolved", () => {
    setSetting("default_model", {
      provider: "anthropic",
      modelId: "does-not-exist",
      runtimeType: "pi",
      thinkingLevel: "medium",
    });

    expect(() => resolveModelSetting("default_model")).toThrow(/Configured default_model is invalid/);
  });

  test("rejects model settings for an inert legacy runtime", () => {
    setSetting("default_model", {
      provider: "claude_agent_sdk",
      modelId: "claude-sonnet-4-6",
      runtimeType: "claude_agent_sdk",
      thinkingLevel: "medium",
    });
    expect(() => resolveModelSetting("default_model")).toThrow("unavailable runtime 'claude_agent_sdk'");

    setSetting("utility_model", {
      provider: "openai-codex",
      modelId: "missing-utility",
      runtimeType: "pi",
      thinkingLevel: "minimal",
    });
    expect(() => resolveUtilityModel()).toThrow("Configured utility_model is invalid");
  });

  test("ignores REINS_PROVIDER/REINS_MODEL env vars when no default model is configured", () => {
    deleteSetting("default_model");

    const prevProvider = process.env.REINS_PROVIDER;
    const prevModel = process.env.REINS_MODEL;

    try {
      process.env.REINS_PROVIDER = "anthropic";
      process.env.REINS_MODEL = "claude-sonnet-4-5";

      expect(resolveModelSetting("default_model")).toBeUndefined();
    } finally {
      if (prevProvider === undefined) delete process.env.REINS_PROVIDER;
      else process.env.REINS_PROVIDER = prevProvider;

      if (prevModel === undefined) delete process.env.REINS_MODEL;
      else process.env.REINS_MODEL = prevModel;
    }
  });
});

describe("canonical session model selection", () => {
  useTestDb();
  const repo = useTestRepo();

  test("requires an explicit configured model for a new session", async () => {
    deleteSetting("default_model");
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");
    await expect(createNewSession(state, project.id, repo.dir)).rejects.toThrow("requires an explicit model");
  });

  test("rejects a Claude-runtime default instead of routing it through Pi", async () => {
    setSetting("default_model", {
      provider: "claude_agent_sdk",
      modelId: "claude-sonnet-4-6",
      runtimeType: "claude_agent_sdk",
      thinkingLevel: "high",
    });
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");
    await expect(createNewSession(state, project.id, repo.dir)).rejects.toThrow(
      "Configured default_model uses unavailable runtime 'claude_agent_sdk'",
    );
  });

  test("applies configured model and thinking to a new session", async () => {
    setSetting("default_model", { provider: "anthropic", modelId: "claude-sonnet-4-5", runtimeType: "pi", thinkingLevel: "high" });
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");
    const managed = await createNewSession(state, project.id, repo.dir);
    expect(managed.runtime.getSessionMetadata?.()).toEqual({ model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinkingLevel: "high" });
    expect(getSession(managed.id)).toMatchObject({ agent_runtime_type: "pi", model_provider: "anthropic", model_id: "claude-sonnet-4-5", thinking_level: "high" });
    await managed.runtime.close();
  });

  test("reports an invalid configured model without fallback", async () => {
    setSetting("default_model", { provider: "anthropic", modelId: "does-not-exist", runtimeType: "pi", thinkingLevel: "high" });
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");
    await expect(createNewSession(state, project.id, repo.dir)).rejects.toThrow("Configured default_model is invalid");
  });

  test("resumes with persisted model identity and rejects unavailable identities", async () => {
    const state = createServerState();
    const project = createProject("Test Project", repo.dir, "main");
    createSession("valid", project.id, { agentRuntimeType: "pi", modelProvider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "minimal" });
    const managed = await ensureSessionOpen(state, "valid");
    expect(managed.runtime.getSessionMetadata?.()).toEqual({ model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, thinkingLevel: "minimal" });
    await managed.runtime.close();

    createSession("invalid", project.id, { agentRuntimeType: "pi", modelProvider: "anthropic", modelId: "retired", thinkingLevel: "high" });
    await expect(ensureSessionOpen(state, "invalid")).rejects.toThrow("Selected session model is invalid: anthropic/retired");
  });
});
