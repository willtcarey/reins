/**
 * The openai-images extension (docs/features/images.md): image models from OpenAI-compatible images APIs
 * (OpenAI, SGLang) that the user adds in Settings, for agents' `api.images`. It uses only the server SDK.
 */

import type { ServerExtension, ServerSdk } from "@reins/sdk/server";
import { openaiImagesApi } from "./api.js";
import { EndpointError, Endpoints } from "./endpoints.js";
import { openaiImagesMigrations } from "./migrations.js";
import { openaiImagesProvider } from "./provider.js";
import { listModels } from "./client.js";

function register(reins: ServerSdk) {
  const endpoints = new Endpoints(reins.db, reins.secrets);
  const removals = [
    reins.images.registerProvider(openaiImagesProvider(endpoints, reins.logger)),
    reins.http.handle(openaiImagesApi, {
      list: () => endpoints.list(),
      add: ({ input }) => endpoints.add(input),
      update: ({ input }) => endpoints.update(input.id, input.changes),
      remove: ({ input }) => endpoints.remove(input.id),
      test: async ({ input, signal }) => {
        const endpoint = await endpoints.withKeyOf(input.id);
        try {
          return { models: await listModels(endpoint, signal) };
        } catch (error) {
          throw new EndpointError(502, error instanceof Error ? error.message : String(error));
        }
      },
    }),
  ];
  return async () => { for (const remove of removals) await remove(); };
}

export const openaiImages: ServerExtension = { migrations: openaiImagesMigrations, register };
