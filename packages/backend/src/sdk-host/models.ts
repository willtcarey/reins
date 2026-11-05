/** `models` (docs/dev/server-sdk.md): the AI providers and their models, `reins.models`, for an extension and an
 * agent's script alike. */

import { Type } from "@sinclair/typebox";
import type { ScriptNamespace } from "@reins/sdk/server";
import { listRuntimeProviders } from "../pi/model-catalog.js";
import { sdkMethod, type CallContext } from "./declaration.js";

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

const list = sdkMethod({
  description:
    "List all available AI providers with their models, including whether each provider is available " +
    "and the availability source (db, env, oauth, or local). Each provider includes its models " +
    "with id, name, reasoning capability, context window, and max tokens.",
  params: [],
  returns: Type.Array(ProviderInfoSchema),
  tags: ["models", "providers", "list", "read", "ai", "configuration"],
  run: context => listRuntimeProviders(context.models.credentials),
});

const listProviders = sdkMethod({
  description: "List available AI provider names (e.g. 'anthropic', 'openai').",
  params: [],
  returns: Type.Array(Type.String()),
  tags: ["models", "providers", "list", "read", "names"],
  run: async context => (await listRuntimeProviders(context.models.credentials)).map(provider => provider.provider),
});

export const MODELS = { namespace: "models", methods: { list, listProviders }, types: { ProviderInfo: ProviderInfoSchema, ModelInfo: ModelInfoSchema } } satisfies ScriptNamespace<CallContext>;
