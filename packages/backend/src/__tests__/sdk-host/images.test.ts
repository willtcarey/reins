import { describe, expect, test } from "bun:test";
import type { ImageRequest, ImagesProvider, RegisterExtension, ServerSdk } from "@reins/sdk/server";
import { runScript } from "../../tools/execute.js";
import { searchScriptApi } from "../../tools/search.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { scriptContext } from "../helpers/script-context.js";

const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

/** A provider of `models` that answers each generation with one image and records it. */
function provider(models: string[], generations: { model: string; request: ImageRequest }[] = []): ImagesProvider {
  return {
    models: async () => models,
    async generate(model, request) {
      generations.push({ model, request });
      return [image];
    },
  };
}

const extension = (images: ImagesProvider): RegisterExtension => reins => reins.images.registerProvider(images);

const app = (extensions: { name: string; register: RegisterExtension }[], errors: string[] = []): TestAppState => createAppState(undefined, {
  extensions,
  onExtensionError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
});

async function run(state: TestAppState, code: string) {
  const result = await runScript(scriptContext(state, { sessionId: "caller" }), code);
  if (!result.ok) throw new Error(result.error);
  return result;
}
const value = async (state: TestAppState, code: string) => JSON.parse((await run(state, code)).text);

describe("api.images", () => {
  useTestDb();

  test("list gives every provider's models as <extension>__<model>", async () => {
    const state = app([
      { name: "first", register: extension(provider(["local/qwen"])) },
      { name: "second", register: extension(provider(["dall-e", "gpt-image"])) },
    ]);
    expect(await value(state, "return await api.images.list()")).toEqual(["first__local/qwen", "second__dall-e", "second__gpt-image"]);
  });

  test("an extension lists and uses another extension's image models through reins.images, as scripts do", async () => {
    const generations: { model: string; request: ImageRequest }[] = [];
    let reins: ServerSdk | undefined;
    app([
      { name: "maker", register: extension(provider(["sketch"], generations)) },
      { name: "user", register: sdk => { reins = sdk; return () => {}; } },
    ]);

    expect(await reins!.images.list()).toEqual(["maker__sketch"]);
    expect(await reins!.images.generate("a boat", { size: "256x256" })).toEqual({ model: "maker__sketch", images: [image] });
    expect(generations).toEqual([{ model: "sketch", request: { prompt: "a boat", size: "256x256" } }]);
  });

  test("generate gives the model's provider its own ID and the request", async () => {
    const generations: { model: string; request: ImageRequest }[] = [];
    const state = app([
      { name: "first", register: extension(provider(["a"])) },
      { name: "second", register: extension(provider(["b/c"], generations)) },
    ]);

    const result = await value(state, `return await api.images.generate("a cat", {
      model: "second__b/c", images: [${JSON.stringify(image)}], size: "512x512", count: 2, parameters: { seed: 7 },
    })`);

    expect(result).toEqual({ model: "second__b/c", images: [image] });
    expect(generations).toEqual([{ model: "b/c", request: { prompt: "a cat", images: [image], size: "512x512", count: 2, parameters: { seed: 7 } } }]);
  });

  test("without a model it uses the first listed, and an earlier result can be the images to edit", async () => {
    const generations: { model: string; request: ImageRequest }[] = [];
    const state = app([{ name: "first", register: extension(provider(["one", "two"], generations)) }]);

    const result = await run(state, `
      const first = await api.images.generate("a cat");
      image(await api.images.generate("make it blue", { images: first }));
    `);

    expect(generations).toEqual([
      { model: "one", request: { prompt: "a cat" } },
      { model: "one", request: { prompt: "make it blue", images: [image] } },
    ]);
    expect(result.content).toEqual([image]);
  });

  test("no models, and an unknown model, throw", async () => {
    await expect(run(app([]), `return await api.images.generate("x")`)).rejects.toThrow("No image models");
    const state = app([{ name: "first", register: extension(provider(["one"])) }]);
    await expect(run(state, `return await api.images.generate("x", { model: "nobody__one" })`)).rejects.toThrow("Unknown image model: nobody__one");
  });

  test("an extension has one image provider at a time", () => {
    const errors: string[] = [];
    app([{ name: "twice", register: reins => {
      void reins.images.registerProvider(provider([]))();
      reins.images.registerProvider(provider([]));
      reins.images.registerProvider(provider([]));
      return () => {};
    } }], errors);
    expect(errors).toEqual(["twice: An extension registers one image provider at a time"]);
  });

  test("search documents api.images", () => {
    expect(searchScriptApi("images generate", undefined).text).toContain("generate(prompt: string");
  });
});
