/**
 * The image models agents can use (`api.images`): each extension's image provider (`reins.images`), and the
 * models they give, by final ID, `<extension>__<local ID>`. The providers are asked at each list and each
 * generation, so a model a provider gains or loses shows at once. The host holds one and gives it the
 * providers its extensions register (docs/dev/server-sdk.md *Images*).
 */

import type { ImageBlock, ImageRequest, ImagesProvider } from "@reins/sdk/server";
import { ID_SEPARATOR } from "./ids.js";

/** A local ID may hold `/` and `.` (`endpoint/Qwen/Qwen-Image`), as it is never a tool name. */
const LOCAL_ID = /^\S{1,200}$/;

export class UnknownImageModelError extends Error {
  constructor(id: string) {
    super(`Unknown image model: ${id}. List them with api.images.list().`);
    this.name = "UnknownImageModelError";
  }
}

/** An image model as agents see it. */
export interface ImageModelView {
  /** `<extension>__<local ID>`. */
  id: string;
  name: string;
  description?: string;
  /** Its provider's title. */
  provider: string;
  input: ("text" | "image")[];
}

export interface ImageModelList {
  models: ImageModelView[];
  /** Providers whose list failed, with why. */
  unavailable: { provider: string; error: string }[];
}

export interface ImageGeneration {
  /** The final ID of the model that made them. */
  model: string;
  images: ImageBlock[];
  text?: string;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export class ImageModels {
  private readonly providers: { extension: string; provider: ImagesProvider }[] = [];

  /** `report`: an extension's mistake that does not fail the request (a model ID that breaks the rules). */
  constructor(private readonly report: (extension: string, error: unknown) => void) {}

  /** Adds `extension`'s provider, its only one; returns its removal. */
  add(extension: string, provider: ImagesProvider): () => void {
    if (this.providerOf(extension)) throw new Error("An extension registers one image provider: remove the one it has first");
    const entry = { extension, provider };
    this.providers.push(entry);
    return () => {
      const index = this.providers.indexOf(entry);
      if (index >= 0) this.providers.splice(index, 1);
    };
  }

  providerOf(extension: string): ImagesProvider | undefined {
    return this.providers.find(entry => entry.extension === extension)?.provider;
  }

  /** Every provider's models, by provider in the order of registration; all are asked at once. A provider
   * that throws is in `unavailable`; a model whose ID breaks the rules is left out and reported. */
  async list(signal: AbortSignal): Promise<ImageModelList> {
    const answers = await Promise.all([...this.providers].map(async ({ extension, provider }) => {
      try {
        const models = await provider.models({ signal });
        return { models: models.flatMap((model): ImageModelView[] => {
          if (typeof model?.id !== "string" || !LOCAL_ID.test(model.id)) {
            this.report(extension, new Error(`Image model ID ${String(model?.id)} is left out: a local ID has no whitespace and at most 200 characters`));
            return [];
          }
          return [{
            id: `${extension}${ID_SEPARATOR}${model.id}`, name: model.name ?? model.id,
            ...(model.description ? { description: model.description } : {}),
            provider: provider.title, input: [...model.input],
          }];
        }) };
      } catch (error) {
        return { unavailable: { provider: provider.title, error: errorMessage(error) } };
      }
    }));
    return {
      models: answers.flatMap(answer => answer.models ?? []),
      unavailable: answers.flatMap(answer => answer.unavailable ? [answer.unavailable] : []),
    };
  }

  /** Makes images with model `id`, or without one the first listed. The provider its prefix names gets its
   * local ID; `UnknownImageModelError` when there is none, or the ID is not one. The provider's answer is
   * checked, as an extension without TypeScript can give anything. */
  async generate(id: string | undefined, request: ImageRequest, signal: AbortSignal): Promise<ImageGeneration> {
    const model = id ?? await this.firstModel(signal);
    const at = model.indexOf(ID_SEPARATOR);
    const localId = model.slice(at + ID_SEPARATOR.length);
    const entry = at > 0 && LOCAL_ID.test(localId) ? this.providers.find(candidate => candidate.extension === model.slice(0, at)) : undefined;
    if (!entry) throw new UnknownImageModelError(model);
    const { title } = entry.provider;
    const result: unknown = await entry.provider.generate(localId, request, { signal });
    const images: unknown[] | null = typeof result === "object" && result !== null && "images" in result && Array.isArray(result.images) ? result.images : null;
    if (!images) throw new Error(`${title} gave no images`);
    const blocks = images.map((image): ImageBlock => {
      if (typeof image !== "object" || image === null || !("data" in image) || typeof image.data !== "string"
        || !("mimeType" in image) || typeof image.mimeType !== "string") {
        throw new Error(`${title} gave an image that is not { type: "image", data, mimeType }`);
      }
      return { type: "image", data: image.data, mimeType: image.mimeType };
    });
    const text = typeof result === "object" && result !== null && "text" in result && typeof result.text === "string" && result.text ? result.text : undefined;
    return { model, images: blocks, ...(text ? { text } : {}) };
  }

  private async firstModel(signal: AbortSignal): Promise<string> {
    const { models, unavailable } = await this.list(signal);
    const first = models[0]?.id;
    if (first) return first;
    const why = unavailable.map(entry => `${entry.provider}: ${entry.error}`).join("; ");
    throw new Error(`No image models. Add an image provider (for example an OpenAI images endpoint in Settings).${why ? ` Unavailable: ${why}` : ""}`);
  }
}
