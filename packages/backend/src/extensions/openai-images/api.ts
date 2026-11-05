/**
 * The openai-images extension's HTTP API (`reins.http`): schemas only, so the frontend part imports its type
 * (`OpenAiImagesApi`) for `reins.http.call`. Handled in `index.ts`.
 */

import { Type, type TSchema } from "@sinclair/typebox";
import type { HttpApi } from "@reins/sdk/server";

const nullable = <T extends TSchema>(schema: T, description: string) => Type.Optional(Type.Union([schema, Type.Null()], { description }));

/** A new endpoint. `endpoints.ts` checks what a schema cannot (the URL, the model IDs). */
export const EndpointInputSchema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$", description: "Lowercase letters, digits and hyphens, starting with a letter; at most 32; unique. Agents see it in model IDs." }),
  baseUrl: Type.String({ maxLength: 2000, description: "The API's base URL, with its version, e.g. http://host:30010/v1." }),
  apiKey: nullable(Type.String({ maxLength: 8000 }), "Sent as a bearer token; stored encrypted and never returned."),
  models: nullable(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 100 }), "The models to offer; null or absent: every model the server lists (GET /models)."),
  defaultParameters: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Merged into each request, e.g. { \"output_format\": \"png\" }." })),
  randomSeed: Type.Optional(Type.Boolean({ description: "Send a random `seed` with each request that has none, for a server that uses a fixed seed otherwise (SGLang). OpenAI refuses `seed`." })),
}, { additionalProperties: false });

/** A change: what is left out is kept; an API key or model list given as null is removed. */
export const EndpointChangesSchema = Type.Partial(EndpointInputSchema, { additionalProperties: false });

export const EndpointViewSchema = Type.Object({
  id: Type.Integer(),
  name: Type.String(),
  baseUrl: Type.String(),
  hasApiKey: Type.Boolean(),
  models: Type.Union([Type.Array(Type.String()), Type.Null()]),
  defaultParameters: Type.Record(Type.String(), Type.Unknown()),
  randomSeed: Type.Boolean(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const EndpointId = Type.Object({ id: Type.Integer() });

export const openaiImagesApi = {
  /** Every endpoint, in name order. */
  list: { output: Type.Array(EndpointViewSchema) },
  /** 400: invalid; 409: the name is taken. */
  add: { input: EndpointInputSchema, output: EndpointViewSchema },
  update: { input: Type.Object({ id: EndpointId.properties.id, changes: EndpointChangesSchema }), output: EndpointViewSchema },
  /** Removes it and its API key. */
  remove: { input: EndpointId },
  /** The models the server lists now (502: it did not answer). */
  test: { input: EndpointId, output: Type.Object({ models: Type.Array(Type.String()) }) },
} satisfies HttpApi;

export type OpenAiImagesApi = typeof openaiImagesApi;
