import { describe, expect, test } from "bun:test";
import type { ImageModel, ImageRequest, ImagesProvider, RegisterExtension } from "@reins/sdk/server";
import { runScript } from "../../tools/execute.js";
import { searchScriptApi } from "../../tools/search.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { scriptContext } from "../helpers/script-context.js";
import { noisePng } from "../helpers/noise-png.js";

const png = Buffer.from(noisePng(2, 2)).toString("base64");
const imageOf = (data = png) => ({ type: "image" as const, data, mimeType: "image/png" });

interface Generation { modelId: string; request: ImageRequest; aborted: boolean }

/** A provider of `models` that answers each generation with one image and records it. */
function provider(title: string, models: ImageModel[] | (() => Promise<ImageModel[]>), generations: Generation[] = []): ImagesProvider {
  return {
    title,
    models: async () => typeof models === "function" ? models() : models,
    async generate(modelId, request, { signal }) {
      if (!(typeof models === "function" ? await models() : models).some(model => model.id === modelId)) throw new Error(`No model ${modelId}`);
      generations.push({ modelId, request, aborted: signal.aborted });
      return { images: [imageOf()], text: `${title} made ${request.prompt}` };
    },
  };
}

const extension = (images: ImagesProvider): RegisterExtension => reins => reins.images.registerProvider(images);

function app(extensions: { name: string; register: RegisterExtension }[], errors: string[] = []): TestAppState {
  return createAppState(undefined, {
    extensions,
    onExtensionError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
  });
}

async function run(state: TestAppState, code: string) {
  const result = await runScript(scriptContext(state, { sessionId: "caller" }), code);
  if (!result.ok) throw new Error(result.error);
  return result;
}
const value = async (state: TestAppState, code: string) => JSON.parse((await run(state, code)).text);

describe("api.images", () => {
  useTestDb();

  test("list gives every provider's models by their final IDs, <extension>__<local ID>, and a provider that fails in unavailable", async () => {
    const errors: string[] = [];
    const state = app([
      { name: "first", register: extension(provider("First images", [
        { id: "local/qwen-image.2", name: "Qwen", description: "Fast", input: ["text", "image"] },
        { id: "has space", input: ["text"] },
        { id: "x".repeat(201), input: ["text"] },
      ])) },
      { name: "broken", register: extension(provider("Broken images", async () => { throw new Error("offline"); })) },
      { name: "second", register: extension(provider("Second images", [{ id: "dall-e", input: ["text"] }])) },
    ], errors);

    expect(await value(state, "return await api.images.list()")).toEqual({
      models: [
        { id: "first__local/qwen-image.2", name: "Qwen", description: "Fast", provider: "First images", input: ["text", "image"] },
        { id: "second__dall-e", name: "dall-e", provider: "Second images", input: ["text"] },
      ],
      unavailable: [{ provider: "Broken images", error: "offline" }],
    });
    expect(errors).toEqual([
      "first: Image model ID has space is left out: a local ID has no whitespace and at most 200 characters",
      `first: Image model ID ${"x".repeat(201)} is left out: a local ID has no whitespace and at most 200 characters`,
    ]);
  });

  test("generate gives the model's provider its local ID and the request, and answers its images with the final ID", async () => {
    const generations: Generation[] = [];
    const state = app([
      { name: "first", register: extension(provider("First", [{ id: "a", input: ["text"] }])) },
      { name: "second", register: extension(provider("Second", [{ id: "b/c", input: ["text", "image"] }], generations)) },
    ]);

    const result = await value(state, `return await api.images.generate("a cat", {
      model: "second__b/c", images: [{ type: "image", data: "${png}", mimeType: "image/png" }], size: "512x512", count: 2, parameters: { seed: 7 },
    })`);

    expect(result).toEqual({ model: "second__b/c", images: [imageOf()], text: "Second made a cat" });
    expect(generations).toEqual([{
      modelId: "b/c",
      request: { prompt: "a cat", images: [imageOf()], size: "512x512", count: 2, parameters: { seed: 7 } },
      aborted: false,
    }]);
  });

  test("generate's images can be an earlier result, and image() shows a result to the model", async () => {
    const generations: Generation[] = [];
    const state = app([{ name: "first", register: extension(provider("First", [{ id: "a", input: ["text", "image"] }], generations)) }]);

    const result = await run(state, `
      const first = await api.images.generate("a cat");
      image(await api.images.generate("make it blue", { images: first }));
    `);

    expect(generations.map(generation => generation.request)).toEqual([{ prompt: "a cat" }, { prompt: "make it blue", images: [imageOf()] }]);
    expect(result.content).toEqual([imageOf()]);
  });

  test("without a model, generate uses the first listed; with none it says to add an image provider; an unknown model throws", async () => {
    const generations: Generation[] = [];
    const state = app([
      { name: "empty", register: extension(provider("Empty", [])) },
      { name: "second", register: extension(provider("Second", [{ id: "one", input: ["text"] }, { id: "two", input: ["text"] }], generations)) },
    ]);
    expect((await value(state, `return await api.images.generate("x")`)).model).toBe("second__one");
    expect(generations.map(generation => generation.modelId)).toEqual(["one"]);

    await expect(run(state, `return await api.images.generate("x", { model: "second__three" })`)).rejects.toThrow("No model three");
    await expect(run(state, `return await api.images.generate("x", { model: "nobody__one" })`)).rejects.toThrow("Unknown image model: nobody__one. List them with api.images.list().");
    await expect(run(state, `return await api.images.generate("x", { model: "second__has space" })`)).rejects.toThrow("Unknown image model");

    const none = app([{ name: "broken", register: extension(provider("Broken", async () => { throw new Error("offline"); })) }]);
    await expect(run(none, `return await api.images.generate("x")`)).rejects.toThrow(
      "No image models. Add an image provider (for example an OpenAI images endpoint in Settings). Unavailable: Broken: offline",
    );
  });

  test("a provider's answer that is not images is refused", async () => {
    // As an extension without TypeScript can answer.
    const bad: ImagesProvider = JSON.parse(JSON.stringify({ title: "Bad" }));
    bad.models = async () => [{ id: "m", input: ["text"] }];
    bad.generate = async () => JSON.parse(JSON.stringify({ images: [{ data: 1 }] }));
    const state = app([{ name: "bad", register: reins => reins.images.registerProvider(bad) }]);
    await expect(run(state, `return await api.images.generate("x")`)).rejects.toThrow("Bad gave an image that is not { type: \"image\", data, mimeType }");
  });

  test("an extension has one image provider at a time", async () => {
    const errors: string[] = [];
    app([{ name: "twice", register: reins => {
      const remove = reins.images.registerProvider(provider("One", []));
      void remove();
      reins.images.registerProvider(provider("Two", []));
      reins.images.registerProvider(provider("Three", []));
      return () => {};
    } }], errors);
    expect(errors).toEqual(["twice: An extension registers one image provider: remove the one it has first"]);
  });

  test("search documents api.images", () => {
    const { text } = searchScriptApi("images generate", undefined);
    expect(text).toContain("generate(prompt: string");
    expect(text).toContain("interface ImageModelInfo");
  });
});
