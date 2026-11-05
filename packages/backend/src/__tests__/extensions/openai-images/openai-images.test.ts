import { afterEach, describe, expect, test } from "bun:test";
import { openaiImages } from "../../../extensions/openai-images/index.js";
import { buildRouter } from "../../../routes/index.js";
import { runScript } from "../../../tools/execute.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { makeRequest } from "../../helpers/request.js";
import { useTestDb } from "../../helpers/test-db.js";
import { scriptContext } from "../../helpers/script-context.js";
import { FAKE_IMAGE, FAKE_IMAGE_BASE64, startFakeOpenAiImages, type FakeImagesServer } from "../../helpers/fake-openai-images.js";
import { getDb } from "../../../app-globals.js";

const router = buildRouter();
const fakes: FakeImagesServer[] = [];
const fakeServer = () => {
  const fake = startFakeOpenAiImages();
  fakes.push(fake);
  return fake;
};
afterEach(async () => { await Promise.all(fakes.splice(0).map(fake => fake.stop())); });

const app = () => createAppState(undefined, { extensions: [{ name: "openai-images", ...openaiImages }] });

async function call(state: TestAppState, method: string, input?: unknown): Promise<{ status: number; json: any }> {
  const res = (await router.handle(makeRequest("POST", `/api/extensions/openai-images/${method}`, input), state))!;
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function script(state: TestAppState, code: string) {
  const result = await runScript(scriptContext(state, { sessionId: "caller" }), code);
  if (!result.ok) throw new Error(result.error);
  return JSON.parse(result.text);
}

const image = { type: "image", data: FAKE_IMAGE_BASE64, mimeType: "image/png" };

describe("the openai-images extension", () => {
  useTestDb();

  describe("its endpoints (HTTP API)", () => {
    test("add, list, update and remove an endpoint; its API key is kept in the secrets and only said to be there", async () => {
      const state = app();
      const added = await call(state, "add", {
        name: "local", baseUrl: "http://example.test/v1", apiKey: "sk-1", models: ["m1"], defaultParameters: { output_format: "png" },
      });
      expect(added.status).toBe(200);
      expect(added.json).toEqual({
        id: expect.any(Number), name: "local", baseUrl: "http://example.test/v1", hasApiKey: true, models: ["m1"],
        defaultParameters: { output_format: "png" }, randomSeed: false, createdAt: expect.any(String), updatedAt: expect.any(String),
      });
      expect(JSON.stringify(state.extensions.list())).not.toContain("sk-1");
      const secret = getDb().query<{ value: string }, []>("SELECT value FROM extension_secrets WHERE extension = 'openai-images'").get();
      expect(secret?.value).not.toContain("sk-1");

      const { id } = added.json;
      const updated = await call(state, "update", { id, changes: { apiKey: null, models: null, baseUrl: "https://other.test/v1/", randomSeed: true } });
      expect(updated.json).toMatchObject({ hasApiKey: false, models: null, baseUrl: "https://other.test/v1/", defaultParameters: { output_format: "png" }, randomSeed: true });
      expect((await call(state, "list")).json).toEqual([updated.json]);

      expect((await call(state, "remove", { id })).status).toBe(204);
      expect((await call(state, "list")).json).toEqual([]);
      expect(getDb().query("SELECT * FROM extension_secrets WHERE extension = 'openai-images'").all()).toEqual([]);
    });

    test("invalid input is 400, a taken name 409 and an unknown endpoint 404", async () => {
      const state = app();
      expect(await call(state, "add", { name: "Bad Name", baseUrl: "http://x.test" })).toMatchObject({ status: 400, json: { error: expect.stringContaining("name") } });
      expect(await call(state, "add", { name: "ok", baseUrl: "ftp://x.test" })).toMatchObject({ status: 400, json: { error: "The base URL must be http or https" } });
      expect(await call(state, "add", { name: "ok", baseUrl: "http://x.test", models: ["has space"] })).toMatchObject({ status: 400 });
      expect((await call(state, "add", { name: "ok", baseUrl: "http://x.test" })).status).toBe(200);
      expect(await call(state, "add", { name: "ok", baseUrl: "http://y.test" })).toMatchObject({ status: 409, json: { error: "An endpoint is already named ok" } });
      expect(await call(state, "remove", { id: 999 })).toMatchObject({ status: 404, json: { error: "Endpoint not found: 999" } });
    });

    test("test lists the server's models with the API key, and a server that fails is 502", async () => {
      const fake = fakeServer();
      const state = app();
      const { json } = await call(state, "add", { name: "local", baseUrl: fake.baseUrl, apiKey: "sk-1" });
      expect(await call(state, "test", { id: json.id })).toEqual({ status: 200, json: { models: ["image-one", "image-two"] } });
      expect(fake.requests).toEqual([{ path: "/v1/models", authorization: "Bearer sk-1", body: {} }]);

      await fake.stop();
      expect(await call(state, "test", { id: json.id })).toMatchObject({ status: 502, json: { error: expect.stringContaining("local: ") } });
    });
  });

  describe("its image models (api.images)", () => {
    test("each endpoint's models are <endpoint>/<model>: its configured list, else all the server lists", async () => {
      const fake = fakeServer();
      const state = app();
      await call(state, "add", { name: "all", baseUrl: fake.baseUrl });
      await call(state, "add", { name: "some", baseUrl: fake.baseUrl, models: ["Qwen/Qwen-Image"] });

      const { models, unavailable } = await script(state, "return await api.images.list()");
      expect(models.map((model: { id: string }) => model.id)).toEqual([
        "openai-images__all/image-one", "openai-images__all/image-two", "openai-images__some/Qwen/Qwen-Image",
      ]);
      expect(models[0]).toEqual({
        id: "openai-images__all/image-one", name: "image-one", description: `all (${fake.baseUrl})`, provider: "OpenAI images", input: ["text", "image"],
      });
      expect(unavailable).toEqual([]);
    });

    test("an endpoint that cannot list is left out while another can; when none can, the provider is unavailable", async () => {
      const fake = fakeServer();
      const state = app();
      await call(state, "add", { name: "down", baseUrl: "http://127.0.0.1:1/v1" });
      expect(await script(state, "return await api.images.list()")).toEqual({
        models: [], unavailable: [{ provider: "OpenAI images", error: expect.stringContaining("down: ") }],
      });
      await call(state, "add", { name: "up", baseUrl: fake.baseUrl, models: ["m"] });
      expect((await script(state, "return await api.images.list()")).models.map((model: { id: string }) => model.id)).toEqual(["openai-images__up/m"]);
    });

    test("a generation posts JSON with the defaults and the request's parameters, and reads b64_json", async () => {
      const fake = fakeServer();
      const state = app();
      await call(state, "add", { name: "local", baseUrl: fake.baseUrl, apiKey: "sk-1", defaultParameters: { output_format: "png", quality: "low" } });

      const result = await script(state, `return await api.images.generate("a fox", {
        model: "openai-images__local/image-one", size: "512x512", count: 2, parameters: { quality: "high", seed: 3 },
      })`);

      expect(result).toEqual({ model: "openai-images__local/image-one", images: [image, image], text: "revised a fox" });
      expect(fake.requests).toEqual([{
        path: "/v1/images/generations", authorization: "Bearer sk-1",
        body: { output_format: "png", quality: "high", seed: 3, model: "image-one", prompt: "a fox", n: 2, size: "512x512" },
      }]);
    });

    test("an answer by url is fetched from the server, relative to the base URL; a revised prompt equal to the prompt is no text", async () => {
      const fake = fakeServer();
      fake.answer = "url";
      const state = app();
      await call(state, "add", { name: "local", baseUrl: `${fake.baseUrl}/` });
      expect(await script(state, `return await api.images.generate("a fox", { model: "openai-images__local/image-one" })`)).toEqual({
        model: "openai-images__local/image-one", images: [image],
      });
      expect(fake.requests[0]!.body).toEqual({ model: "image-one", prompt: "a fox" });
    });

    test("with random seed on, each request without a seed gets a new one, which the result reports; a request's own seed is kept", async () => {
      const fake = fakeServer();
      const state = app();
      await call(state, "add", { name: "local", baseUrl: fake.baseUrl, randomSeed: true });
      const generate = (parameters: string) => script(state, `return await api.images.generate("a fox", { model: "openai-images__local/image-one"${parameters} })`);

      const first = await generate("");
      const second = await generate("");
      const seeds = fake.requests.map(request => request.body.seed);
      for (const seed of seeds) expect(Number.isSafeInteger(seed) && Number(seed) >= 0).toBe(true);
      expect(seeds[0]).not.toBe(seeds[1]);
      expect(first.text).toBe(`revised a fox\nSeed: ${seeds[0]}`);
      expect(second.text).toBe(`revised a fox\nSeed: ${seeds[1]}`);

      await generate(", parameters: { seed: 7 }");
      expect(fake.requests[2]!.body.seed).toBe(7);
    });

    test("with images it posts an edit as multipart: image for one, image[] for several", async () => {
      const fake = fakeServer();
      const state = app();
      await call(state, "add", { name: "local", baseUrl: fake.baseUrl, defaultParameters: { output_format: "png", steps: 4 } });
      const block = JSON.stringify(image);

      await script(state, `return await api.images.generate("blue", { model: "openai-images__local/image-one", images: [${block}] })`);
      await script(state, `return await api.images.generate("blue", { model: "openai-images__local/image-one", images: [${block}, ${block}], size: "64x64" })`);

      const file = { file: "image-1.png", type: "image/png", bytes: FAKE_IMAGE };
      expect(fake.requests.map(request => [request.path, request.body])).toEqual([
        ["/v1/images/edits", { output_format: "png", steps: "4", model: "image-one", prompt: "blue", image: file }],
        ["/v1/images/edits", { output_format: "png", steps: "4", model: "image-one", prompt: "blue", size: "64x64", "image[]": [file, { ...file, file: "image-2.png" }] }],
      ]);
    });

    test("a server's error reaches the script with its message; an unknown endpoint or model ID throws", async () => {
      const fake = fakeServer();
      fake.failure = { status: 500, body: { error: { message: "cannot write mode RGBA as JPEG" } } };
      const state = app();
      await call(state, "add", { name: "local", baseUrl: fake.baseUrl });
      await expect(script(state, `return await api.images.generate("x", { model: "openai-images__local/image-one" })`))
        .rejects.toThrow("local: HTTP 500: cannot write mode RGBA as JPEG");
      await expect(script(state, `return await api.images.generate("x", { model: "openai-images__nowhere/image-one" })`))
        .rejects.toThrow("No image model nowhere/image-one");
      await expect(script(state, `return await api.images.generate("x", { model: "openai-images__local" })`))
        .rejects.toThrow("No image model local");
    });
  });
});
