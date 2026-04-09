/**
 * Models API function definitions and schemas.
 */

import { Type } from "@sinclair/typebox";
import { buildProviderList } from "../pi/models-registry.js";
import { type ApiFunctionDef, defineFunction } from "./define-function.js";

export type {
  KeySourceType,
  ProviderInfo,
  ModelInfo,
} from "../pi/models-registry.js";

// ---------------------------------------------------------------------------
// Function definitions
// ---------------------------------------------------------------------------

const KeySourceSchema = Type.Union([
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
  provider: Type.String(),
  hasKey: Type.Boolean(),
  keySource: Type.Union([KeySourceSchema, Type.Null()]),
  keySources: Type.Array(KeySourceSchema),
  models: Type.Array(ModelInfoSchema),
});

export const modelsListFunction = defineFunction({
  name: "models.list",
  description:
    "List all available AI providers with their models, including whether authentication " +
    "is configured and the key source (db, env, oauth, or local). Each provider includes its models " +
    "with id, name, reasoning capability, context window, and max tokens.",
  parameters: Type.Object({}),
  returns: Type.Array(ProviderInfoSchema),
  tags: ["models", "providers", "list", "read", "ai", "configuration"],
  execute: () => buildProviderList(),
});

export const modelsListProvidersFunction = defineFunction({
  name: "models.listProviders",
  description: "List available AI provider names (e.g. 'anthropic', 'openai').",
  parameters: Type.Object({}),
  returns: Type.Array(Type.String()),
  tags: ["models", "providers", "list", "read", "names"],
  execute: async () => (await buildProviderList()).map((provider) => provider.provider),
});

export const MODEL_FUNCTIONS: ApiFunctionDef[] = [
  modelsListFunction,
  modelsListProvidersFunction,
];
