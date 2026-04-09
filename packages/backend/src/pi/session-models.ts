import { type ModelRegistry } from "@mariozechner/pi-coding-agent";
import { type Api, type Model } from "@mariozechner/pi-ai";
import type { SessionRow } from "../session-store.js";
import type { CreateSessionOpts } from "../tools/delegate.js";
import {
  parseThinkingLevel,
  resolveModel,
  resolveModelSettingWithConfig,
  resolveModelSettingWithConfigInRegistry,
  type ThinkingLevel,
} from "../models/model-settings.js";

export function resolveConfiguredSessionDefaults(
  modelRegistry: Pick<ModelRegistry, "find">,
): {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
} | undefined {
  const configured = resolveModelSettingWithConfigInRegistry("default_model", modelRegistry);
  if (!configured) return undefined;

  return {
    model: configured.model,
    thinkingLevel: configured.config.thinkingLevel,
  };
}

export function resolveRequestedSessionModel(
  modelRegistry: Pick<ModelRegistry, "find">,
  opts?: CreateSessionOpts,
): Model<Api> | undefined {
  if (!opts?.modelProvider && !opts?.modelId) return undefined;
  if (!opts?.modelProvider || !opts?.modelId) {
    throw new Error("Both modelProvider and modelId are required when overriding a session model.");
  }

  const model = resolveModel(opts.modelProvider, opts.modelId, modelRegistry);
  if (!model) {
    throw new Error(`Unknown model override: ${opts.modelProvider}/${opts.modelId}`);
  }

  return model;
}

export function resolvePersistedSessionDefaults(
  modelRegistry: Pick<ModelRegistry, "find">,
  row?: SessionRow | null,
): {
  hasPersistedModel: boolean;
  hasPersistedThinkingLevel: boolean;
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
} {
  const hasPersistedModel = !!(row?.model_provider && row?.model_id);
  const model = hasPersistedModel ? resolveModel(row!.model_provider!, row!.model_id!, modelRegistry) : undefined;
  if (hasPersistedModel && !model) {
    throw new Error(
      `Persisted session model is invalid: ${row!.model_provider!}/${row!.model_id!}. `
      + "Update the session model in Reins settings or the database.",
    );
  }

  const hasPersistedThinkingLevel = typeof row?.thinking_level === "string" && row.thinking_level.length > 0;
  const thinkingLevel = row?.thinking_level && row.thinking_level !== "off"
    ? parseThinkingLevel(row.thinking_level)
    : undefined;

  return {
    hasPersistedModel,
    hasPersistedThinkingLevel,
    model,
    thinkingLevel,
  };
}

/**
 * Resolve the globally configured default model from settings.
 * Returns undefined when no valid default is configured, allowing the pi SDK
 * to fall back to its built-in default.
 */
export function resolveConfiguredModel(modelRegistry?: Pick<ModelRegistry, "find">): Model<Api> | undefined {
  const configured = resolveModelSettingWithConfig("default_model");
  if (!configured) return undefined;

  const model = resolveModel(configured.config.provider, configured.config.modelId, modelRegistry);
  if (!model) {
    throw new Error(
      `Configured default_model is invalid: ${configured.config.provider}/${configured.config.modelId}. Update it in Settings.`,
    );
  }

  return model;
}
