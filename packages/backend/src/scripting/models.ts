/**
 * Models API function definitions and schemas.
 */

import { Type } from "@sinclair/typebox";
import { listAllRuntimeProviders } from "../runtimes/registry.js";
import { type ApiFunctionDef, defineFunction } from "./define-function.js";

export type {
  AvailabilitySourceType,
  RuntimeProviderInfo as ProviderInfo,
  ModelInfo,
} from "../runtimes/registry.js";

// ---------------------------------------------------------------------------
// Function definitions
// ---------------------------------------------------------------------------

const AvailabilitySourceSchema = Type.Union([
  Type.Literal("db"),
  Type.Literal("env"),
  Type.Literal("oauth"),
  Type.Literal("local"),
]);

export const ModelInfoSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  reasoning: Type.Boolean(),
  contextWindow: Type.Number(),
  maxTokens: Type.Number(),
});

export const ProviderInfoSchema = Type.Object({
  runtimeType: Type.String(),
  provider: Type.String(),
  isAvailable: Type.Boolean(),
  availabilitySource: Type.Union([AvailabilitySourceSchema, Type.Null()]),
  availabilitySources: Type.Array(AvailabilitySourceSchema),
  models: Type.Array(ModelInfoSchema),
});

async function listProvidersAcrossRuntimes() {
  return listAllRuntimeProviders();
}

export const modelsListFunction = defineFunction({
  name: "models.list",
  description:
    "List all available AI providers with their models, including whether each provider is available " +
    "and the availability source (db, env, oauth, or local). Each provider includes its models " +
    "with id, name, reasoning capability, context window, and max tokens.",
  parameters: Type.Object({}),
  returns: Type.Array(ProviderInfoSchema),
  tags: ["models", "providers", "list", "read", "ai", "configuration"],
  execute: () => listProvidersAcrossRuntimes(),
});

export const modelsListProvidersFunction = defineFunction({
  name: "models.listProviders",
  description: "List available AI provider names (e.g. 'anthropic', 'openai').",
  parameters: Type.Object({}),
  returns: Type.Array(Type.String()),
  tags: ["models", "providers", "list", "read", "names"],
  execute: async () => (await listProvidersAcrossRuntimes()).map((provider) => provider.provider),
});

export const MODEL_FUNCTIONS: ApiFunctionDef[] = [
  modelsListFunction,
  modelsListProvidersFunction,
];
