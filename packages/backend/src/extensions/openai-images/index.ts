/**
 * The openai-images extension (docs/features/images.md): image models from OpenAI-compatible images APIs
 * (OpenAI, SGLang), listed in `endpoints.json` in its data directory. Model IDs are `<endpoint>/<model>`.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ImageBlock, ImageRequest, ServerExtension } from "@reins/sdk/server";

const EndpointsSchema = Type.Array(Type.Object({
  name: Type.String({ pattern: "^[a-z0-9-]+$" }),
  /** With its version, e.g. `http://host:30010/v1`. */
  baseUrl: Type.String(),
  apiKey: Type.Optional(Type.String()),
  /** Absent: every model the server lists (`GET /models`). */
  models: Type.Optional(Type.Array(Type.String())),
  /** Merged into each request, e.g. `{ "output_format": "png" }`. */
  parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /** SGLang uses a fixed seed when a request has none, so every image of a prompt is the same. OpenAI refuses `seed`. */
  randomSeed: Type.Optional(Type.Boolean()),
}));
type Endpoint = Static<typeof EndpointsSchema>[number];

const ModelsAnswer = Type.Object({ data: Type.Array(Type.Object({ id: Type.String() })) });
const Nullable = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const ImagesAnswer = Type.Object({ data: Type.Array(Type.Object({ b64_json: Nullable, url: Nullable })) });

/** The server's JSON, as `schema` says, or a throw. */
async function answer<T extends TSchema>(endpoint: Endpoint, response: Response, schema: T): Promise<Static<T>> {
  const body: unknown = await response.json();
  if (!Value.Check(schema, body)) throw new Error(`${endpoint.name}: an answer that is not OpenAI's: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/** Read at each call, so an edit takes effect at once. */
async function readEndpoints(file: string): Promise<Endpoint[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const endpoints: unknown = JSON.parse(text);
  if (Value.Check(EndpointsSchema, endpoints)) return endpoints;
  const problem = Value.Errors(EndpointsSchema, endpoints).First();
  throw new Error(`${file}: ${problem?.path || "/"}: ${problem?.message}`);
}

async function request(endpoint: Endpoint, path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const url = new URL(path, `${endpoint.baseUrl.replace(/\/+$/, "")}/`);
  // The key goes only to the endpoint's own server, not to a storage URL elsewhere.
  const headers = endpoint.apiKey && url.origin === new URL(endpoint.baseUrl).origin ? { Authorization: `Bearer ${endpoint.apiKey}` } : undefined;
  const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal });
  if (!response.ok) throw new Error(`${endpoint.name}: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response;
}

async function listModels(endpoint: Endpoint, signal: AbortSignal): Promise<string[]> {
  const { data } = await answer(endpoint, await request(endpoint, "models", {}, signal), ModelsAnswer);
  return data.map(model => model.id);
}

/** A generation without images, an edit (multipart) with them. No `response_format`: gpt-image models refuse it. */
async function generate(endpoint: Endpoint, model: string, input: ImageRequest, signal: AbortSignal): Promise<ImageBlock[]> {
  const fields: Record<string, unknown> = {
    ...endpoint.parameters, ...input.parameters, model, prompt: input.prompt, n: input.count, size: input.size,
  };
  if (endpoint.randomSeed && fields.seed === undefined) fields.seed = Math.floor(Math.random() * 2 ** 31);
  const images = input.images ?? [];
  let init: RequestInit;
  if (images.length === 0) {
    init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) };
  } else {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    for (const [i, image] of images.entries()) {
      form.append(images.length === 1 ? "image" : "image[]", new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType }), `image-${i + 1}`);
    }
    init = { method: "POST", body: form };
  }
  const path = images.length === 0 ? "images/generations" : "images/edits";
  const { data } = await answer(endpoint, await request(endpoint, path, init, signal), ImagesAnswer);
  const mimeType = `image/${String(fields.output_format ?? "png").replace("jpg", "jpeg")}`;
  const blocks = await Promise.all(data.map(async (item): Promise<ImageBlock> => {
    if (item.b64_json) return { type: "image", data: item.b64_json, mimeType };
    // SGLang answers a URL relative to the server.
    if (!item.url) throw new Error(`${endpoint.name}: an image without b64_json or url`);
    const image = await request(endpoint, item.url, {}, signal);
    const type = image.headers.get("content-type")?.split(";")[0];
    return { type: "image", data: Buffer.from(await image.arrayBuffer()).toString("base64"), mimeType: type?.startsWith("image/") ? type : mimeType };
  }));
  if (blocks.length === 0) throw new Error(`${endpoint.name}: POST /${path} gave no images`);
  return blocks;
}

export const openaiImages: ServerExtension = {
  register: reins => {
    const file = join(reins.dataDir, "endpoints.json");
    return reins.images.registerProvider({
      async models(signal) {
        const lists = await Promise.all((await readEndpoints(file)).map(async endpoint =>
          (endpoint.models ?? await listModels(endpoint, signal)).map(model => `${endpoint.name}/${model}`)));
        return lists.flat();
      },
      async generate(id, input, signal) {
        const at = id.indexOf("/");
        const endpoint = (await readEndpoints(file)).find(candidate => candidate.name === id.slice(0, at));
        if (!endpoint) throw new Error(`No image endpoint for ${id} in ${file}`);
        return generate(endpoint, id.slice(at + 1), input, signal);
      },
    });
  },
};
