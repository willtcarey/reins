/**
 * `api.images`: the image models extensions give agents (docs/dev/server-sdk.md *Images*), over the host's
 * `ImageModels` (`extensions/image-models.ts`).
 */

import { Type } from "@sinclair/typebox";
import { collectImages } from "../tools/script-output.js";
import { type ApiContext, type ApiFunctionDef, defineFunction } from "./define-function.js";

const signalOf = (ctx: ApiContext) => ctx.signal ?? new AbortController().signal;

export const ImageBlockSchema = Type.Object({
  type: Type.Literal("image"),
  data: Type.String({ description: "Base64." }),
  mimeType: Type.String(),
});

export const ImageModelInfoSchema = Type.Object({
  id: Type.String({ description: "<extension>__<model>: give it to generate as model." }),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  provider: Type.String({ description: "Where it comes from." }),
  input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { description: "\"image\": it takes images to edit." }),
});

export const ImageProviderFailureSchema = Type.Object({ provider: Type.String(), error: Type.String() });

export const ImageModelListSchema = Type.Object({
  models: Type.Array(ImageModelInfoSchema),
  unavailable: Type.Array(ImageProviderFailureSchema, { description: "Providers whose models could not be listed." }),
});

export const ImageGenerationSchema = Type.Object({
  model: Type.String(),
  images: Type.Array(ImageBlockSchema),
  text: Type.Optional(Type.String({ description: "Text the model gave with them (a revised prompt)." })),
});

export const imagesListFunction = defineFunction({
  name: "images.list",
  description: "List the image models that extensions give, to use with images.generate.\n\n  return await api.images.list();",
  parameters: Type.Object({}),
  returns: ImageModelListSchema,
  async: true,
  tags: ["images", "image", "models", "generate", "picture"],
  execute: (_params, ctx) => ctx.models.extensions.images.list(signalOf(ctx)),
});

export const imagesGenerateFunction = defineFunction({
  name: "images.generate",
  description:
    "Make images from a prompt with an image model (the first that images.list gives, unless model names one). " +
    "Give images to edit them, with a model whose input has \"image\". It can take tens of seconds. " +
    "The images are not shown to you: give the result to image() to see them.\n\n" +
    "  const result = await api.images.generate(\"a red fox in snow\", { size: \"1024x1024\" });\n" +
    "  image(result);\n" +
    "  return result.text;",
  parameters: Type.Object({
    prompt: Type.String(),
    options: Type.Optional(Type.Object({
      model: Type.Optional(Type.String({ description: "An ID from images.list." })),
      images: Type.Optional(Type.Unknown({ description: "Images to edit: image blocks, { data, mimeType }, or an earlier result of images.generate." })),
      size: Type.Optional(Type.String({ description: "E.g. \"1024x1024\"." })),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "How many images; one by default." })),
      parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The provider's own parameters, given as they are." })),
    })),
  }),
  returns: ImageGenerationSchema,
  async: true,
  tags: ["images", "image", "generate", "create", "draw", "edit", "picture"],
  async execute({ prompt, options = {} }, ctx) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("images.generate: give a prompt");
    const images = options.images === undefined ? undefined : collectImages(options.images);
    return ctx.models.extensions.images.generate(options.model, {
      prompt,
      ...(images ? { images } : {}),
      ...(options.size !== undefined ? { size: options.size } : {}),
      ...(options.count !== undefined ? { count: options.count } : {}),
      ...(options.parameters !== undefined ? { parameters: options.parameters } : {}),
    }, signalOf(ctx));
  },
});

export const IMAGES_FUNCTIONS: ApiFunctionDef[] = [imagesListFunction, imagesGenerateFunction];
