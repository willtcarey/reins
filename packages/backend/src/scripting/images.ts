/** `api.images`: the image models of the extensions' image providers (`reins.images`). */

import { Type } from "@sinclair/typebox";
import type { ExtensionHost } from "../extensions/host.js";
import { collectImages } from "../tools/script-output.js";
import { type ApiContext, type ApiFunctionDef, defineFunction } from "./define-function.js";

const SEPARATOR = "__";

const signalOf = (ctx: ApiContext) => ctx.signal ?? new AbortController().signal;

export const ImageBlockSchema = Type.Object({
  type: Type.Literal("image"),
  data: Type.String({ description: "Base64." }),
  mimeType: Type.String(),
});

export const ImageGenerationSchema = Type.Object({
  model: Type.String(),
  images: Type.Array(ImageBlockSchema),
});

async function listModels(host: ExtensionHost, signal: AbortSignal): Promise<string[]> {
  const lists = await Promise.all([...host.imageProviders].map(async ([extension, provider]) =>
    (await provider.models(signal)).map(id => `${extension}${SEPARATOR}${id}`)));
  return lists.flat();
}

export const imagesListFunction = defineFunction({
  name: "images.list",
  description: "List the image model IDs, to use with images.generate.\n\n  return await api.images.list();",
  parameters: Type.Object({}),
  returns: Type.Array(Type.String()),
  async: true,
  tags: ["images", "image", "models", "generate", "picture"],
  execute: (_params, ctx) => listModels(ctx.models.extensions, signalOf(ctx)),
});

export const imagesGenerateFunction = defineFunction({
  name: "images.generate",
  description:
    "Make images from a prompt (with the first model images.list gives, unless model names one). " +
    "Give images to edit them. It can take tens of seconds. " +
    "The images are not shown to you: give the result to image() to see them.\n\n" +
    "  const result = await api.images.generate(\"a red fox in snow\", { size: \"1024x1024\" });\n" +
    "  image(result);",
  parameters: Type.Object({
    prompt: Type.String(),
    options: Type.Optional(Type.Object({
      model: Type.Optional(Type.String({ description: "An ID from images.list." })),
      images: Type.Optional(Type.Unknown({ description: "Images to edit: anything image() takes." })),
      size: Type.Optional(Type.String({ description: "E.g. \"1024x1024\"." })),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The provider's own parameters, e.g. { seed: 7 }." })),
    })),
  }),
  returns: ImageGenerationSchema,
  async: true,
  tags: ["images", "image", "generate", "create", "draw", "edit", "picture"],
  async execute({ prompt, options = {} }, ctx) {
    const host = ctx.models.extensions;
    const signal = signalOf(ctx);
    const model = options.model ?? (await listModels(host, signal))[0];
    if (!model) throw new Error("No image models: configure an image provider (docs/features/images.md)");
    const at = model.indexOf(SEPARATOR);
    const provider = at > 0 ? host.imageProviders.get(model.slice(0, at)) : undefined;
    if (!provider) throw new Error(`Unknown image model: ${model}. List them with api.images.list().`);
    const { model: _, images, ...rest } = options;
    const request = { prompt, ...rest, ...(images === undefined ? {} : { images: collectImages(images) }) };
    return { model, images: await provider.generate(model.slice(at + SEPARATOR.length), request, signal) };
  },
});

export const IMAGES_FUNCTIONS: ApiFunctionDef[] = [imagesListFunction, imagesGenerateFunction];
