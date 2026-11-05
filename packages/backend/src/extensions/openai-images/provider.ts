/** The extension's image provider: each endpoint's models, as `<endpoint>/<model>`. */

import type { ImageModel, ImagesProvider, Logger } from "@reins/sdk/server";
import type { Endpoints } from "./endpoints.js";
import { generate, listModels } from "./client.js";

export function openaiImagesProvider(endpoints: Endpoints, logger: Logger): ImagesProvider {
  return {
    title: "OpenAI images",
    /** An endpoint that cannot list its models is left out (and logged) while another can, so that one server
     * that is down hides no other; when none can, the list fails with each one's error. */
    async models({ signal }) {
      const all = await endpoints.all();
      const answers = await Promise.all(all.map(async (endpoint): Promise<ImageModel[] | Error> => {
        try {
          const ids = endpoint.models ?? await listModels(endpoint, signal);
          return ids.map(id => ({ id: `${endpoint.name}/${id}`, name: id, description: `${endpoint.name} (${endpoint.baseUrl})`, input: ["text", "image"] }));
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      }));
      const failures = answers.filter(answer => answer instanceof Error);
      if (failures.length > 0 && failures.length === answers.length) throw new Error(failures.map(failure => failure.message).join("; "));
      for (const failure of failures) logger.warn(`Listing image models failed: ${failure.message}`);
      return answers.flatMap(answer => answer instanceof Error ? [] : answer);
    },
    async generate(modelId, request, { signal }) {
      const at = modelId.indexOf("/");
      const endpoint = at > 0 ? await endpoints.byName(modelId.slice(0, at)) : null;
      if (!endpoint || at === modelId.length - 1) throw new Error(`No image model ${modelId}: an ID is <endpoint>/<model>, as api.images.list() gives it`);
      return generate(endpoint, modelId.slice(at + 1), request, signal);
    },
  };
}
