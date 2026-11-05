import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { openaiImages } from "../../../extensions/openai-images/index.js";
import { runScript } from "../../../tools/execute.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { useTestDb } from "../../helpers/test-db.js";
import { scriptContext } from "../../helpers/script-context.js";
import { FAKE_IMAGE, FAKE_IMAGE_BASE64, startFakeOpenAiImages, type FakeImagesServer } from "../../helpers/fake-openai-images.js";

const fakes: FakeImagesServer[] = [];
afterEach(async () => { await Promise.all(fakes.splice(0).map(fake => fake.stop())); });

/** An app with the extension, and `endpoints` as its endpoints.json. */
function app(endpoints: unknown): { state: TestAppState; fake: FakeImagesServer } {
  const fake = startFakeOpenAiImages();
  fakes.push(fake);
  const state = createAppState(undefined, { extensions: [{ name: "openai-images", ...openaiImages }] });
  const dataDir = state.extensions.list().find(extension => extension.name === "openai-images")!.storage!.dataDir;
  writeFileSync(join(dataDir, "endpoints.json"), JSON.stringify(endpoints).replaceAll("FAKE", fake.baseUrl));
  return { state, fake };
}

async function script(state: TestAppState, code: string) {
  const result = await runScript(scriptContext(state, { sessionId: "caller" }), code);
  if (!result.ok) throw new Error(result.error);
  return JSON.parse(result.text);
}

const image = { type: "image", data: FAKE_IMAGE_BASE64, mimeType: "image/png" };
const MODEL = "openai-images__local/image-one";

describe("the openai-images extension", () => {
  useTestDb();

  test("each endpoint's models are <endpoint>/<model>: its own list, else all the server lists", async () => {
    const { state } = app([{ name: "all", baseUrl: "FAKE" }, { name: "some", baseUrl: "FAKE", models: ["Qwen/Qwen-Image"] }]);
    expect(await script(state, "return await api.images.list()")).toEqual([
      "openai-images__all/image-one", "openai-images__all/image-two", "openai-images__some/Qwen/Qwen-Image",
    ]);
  });

  test("an endpoints.json that is not valid is said to be so", async () => {
    const { state } = app([{ name: "local" }]);
    await expect(script(state, "return await api.images.list()")).rejects.toThrow("endpoints.json: /0/baseUrl: ");
  });

  test("a generation posts JSON with the endpoint's parameters, then the request's, and the API key", async () => {
    const { state, fake } = app([{ name: "local", baseUrl: "FAKE", apiKey: "sk-1", parameters: { output_format: "png", quality: "low" } }]);

    const result = await script(state, `return await api.images.generate("a fox", {
      model: "${MODEL}", size: "512x512", count: 2, parameters: { quality: "high", seed: 3 },
    })`);

    expect(result).toEqual({ model: MODEL, images: [image, image] });
    expect(fake.requests).toEqual([{
      path: "/v1/images/generations", authorization: "Bearer sk-1",
      body: { output_format: "png", quality: "high", seed: 3, model: "image-one", prompt: "a fox", n: 2, size: "512x512" },
    }]);
  });

  test("an answer by url is fetched from the server, relative to the base URL", async () => {
    const { state, fake } = app([{ name: "local", baseUrl: "FAKE/" }]);
    fake.answer = "url";
    expect(await script(state, `return await api.images.generate("a fox", { model: "${MODEL}" })`)).toEqual({ model: MODEL, images: [image] });
  });

  test("with randomSeed, each request without a seed gets a new one; a request's own seed is kept", async () => {
    const { state, fake } = app([{ name: "local", baseUrl: "FAKE", randomSeed: true }]);
    for (const parameters of ["", ", parameters: { seed: 7 }"]) {
      await script(state, `return await api.images.generate("a fox", { model: "${MODEL}"${parameters} })`);
    }
    await script(state, `return await api.images.generate("a fox", { model: "${MODEL}" })`);
    const [first, own, third] = fake.requests.map(request => request.body.seed);
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(own).toBe(7);
    expect(third).not.toBe(first);
  });

  test("with images it posts an edit as multipart: image for one, image[] for several", async () => {
    const { state, fake } = app([{ name: "local", baseUrl: "FAKE", parameters: { steps: 4 } }]);
    const block = JSON.stringify(image);

    await script(state, `return await api.images.generate("blue", { model: "${MODEL}", images: [${block}] })`);
    await script(state, `return await api.images.generate("blue", { model: "${MODEL}", images: [${block}, ${block}] })`);

    const file = { file: "image-1", type: "image/png", bytes: FAKE_IMAGE };
    expect(fake.requests.map(request => [request.path, request.body])).toEqual([
      ["/v1/images/edits", { steps: "4", model: "image-one", prompt: "blue", image: file }],
      ["/v1/images/edits", { steps: "4", model: "image-one", prompt: "blue", "image[]": [file, { ...file, file: "image-2" }] }],
    ]);
  });

  test("a server's error reaches the script; an unknown endpoint throws", async () => {
    const { state, fake } = app([{ name: "local", baseUrl: "FAKE" }]);
    fake.failure = { status: 500, body: { error: { message: "cannot write mode RGBA as JPEG" } } };
    await expect(script(state, `return await api.images.generate("x", { model: "${MODEL}" })`)).rejects.toThrow("local: HTTP 500: ");
    await expect(script(state, `return await api.images.generate("x", { model: "openai-images__nowhere/m" })`)).rejects.toThrow("No image endpoint for nowhere/m");
  });
});
