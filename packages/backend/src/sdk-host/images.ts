/**
 * `images` (docs/dev/server-sdk.md *Images*): the image models of the extensions' image providers
 * (`reins.images.registerProvider`), listed and used by an extension (`reins.images`) and an agent's script
 * (`api.images`) alike. A model's ID is `<extension>__<model>`.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionHost } from "../extensions/host.js";
import { collectImages } from "../tools/script-output.js";
import { SignalSchema, sdkMethod, signalOf, type SdkNamespace } from "./declaration.js";

const SEPARATOR = "__";

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

const list = sdkMethod({
  description: "List the image model IDs, to use with images.generate.\n\n  return await api.images.list();",
  params: [{ name: "options", schema: Type.Object({ signal: Type.Optional(SignalSchema) }), optional: true }],
  returns: Type.Array(Type.String()),
  tags: ["images", "image", "models", "generate", "picture"],
  run: (context, options = {}) => listModels(context.models.extensions, signalOf(context, options.signal)),
});

const generate = sdkMethod({
  description:
    "Make images from a prompt (with the first model images.list gives, unless model names one). " +
    "Give images to edit them. It can take tens of seconds. " +
    "The images are not shown to you: give the result to image() to see them.\n\n" +
    "  const result = await api.images.generate(\"a red fox in snow\", { size: \"1024x1024\" });\n" +
    "  image(result);",
  params: [
    { name: "prompt", schema: Type.String() },
    {
      name: "options",
      schema: Type.Object({
        model: Type.Optional(Type.String({ description: "An ID from images.list." })),
        images: Type.Optional(Type.Unknown({ description: "Images to edit: anything image() takes." })),
        size: Type.Optional(Type.String({ description: "E.g. \"1024x1024\"." })),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
        parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The provider's own parameters, e.g. { seed: 7 }." })),
        signal: Type.Optional(SignalSchema),
      }),
      optional: true,
    },
  ],
  returns: ImageGenerationSchema,
  tags: ["images", "image", "generate", "create", "draw", "edit", "picture"],
  async run(context, prompt, options = {}) {
    const host = context.models.extensions;
    const { model: chosen, images, signal: given, ...rest } = options;
    const signal = signalOf(context, given);
    const model = chosen ?? (await listModels(host, signal))[0];
    if (!model) throw new Error("No image models: configure an image provider (docs/features/images.md)");
    const at = model.indexOf(SEPARATOR);
    const provider = at > 0 ? host.imageProviders.get(model.slice(0, at)) : undefined;
    if (!provider) throw new Error(`Unknown image model: ${model}. List them with api.images.list().`);
    const request = { prompt, ...rest, ...(images === undefined ? {} : { images: collectImages(images) }) };
    return { model, images: await provider.generate(model.slice(at + SEPARATOR.length), request, signal) };
  },
});

export const IMAGES = { name: "images", methods: { list, generate }, types: { ImageGeneration: ImageGenerationSchema, ImageBlock: ImageBlockSchema } } satisfies SdkNamespace;
