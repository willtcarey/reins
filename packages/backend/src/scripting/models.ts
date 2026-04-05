/**
 * Models API function definitions and schemas.
 */

import { Type } from "@sinclair/typebox";
import { getProviders } from "@mariozechner/pi-ai";
import { buildProviderList } from "../models-store.js";
import { type ApiFunctionDef, defineFunction } from "./define-function.js";

export type {
  KeySourceType,
  ProviderInfo,
  ModelInfo,
} from "../models-store.js";

// ---------------------------------------------------------------------------
// Function definitions
// ---------------------------------------------------------------------------

export const MODEL_FUNCTIONS: ApiFunctionDef[] = [
  defineFunction({
    name: "models.list",
    description:
      "List all available AI providers with their models, including whether an API key " +
      "is configured and the key source (db or env). Each provider includes its models " +
      "with id, name, reasoning capability, context window, and max tokens.",
    parameters: Type.Object({}),
    returns: Type.Array(Type.Unknown()),
    tags: ["models", "providers", "list", "read", "ai", "configuration"],
    execute: () => buildProviderList(),
  }),
  defineFunction({
    name: "models.listProviders",
    description: "List available AI provider names (e.g. 'anthropic', 'openai').",
    parameters: Type.Object({}),
    returns: Type.Array(Type.String()),
    tags: ["models", "providers", "list", "read", "names"],
    execute: () => [...getProviders()],
  }),
];
