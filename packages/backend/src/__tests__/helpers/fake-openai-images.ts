/**
 * A fake OpenAI images server (`/v1/models`, `/v1/images/generations`, `/v1/images/edits`) for the
 * openai-images extension's tests. It records each request, and answers each image as `b64_json` or, as
 * SGLang does, as a relative `url` to fetch.
 */

import { noisePng } from "./noise-png.js";

export interface FakeImagesRequest {
  path: string;
  authorization: string | null;
  /** The JSON body, or the multipart fields (each file as `{ file: name, type, bytes }`). */
  body: Record<string, unknown>;
}

export interface FakeImagesServer {
  /** `http://127.0.0.1:<port>/v1`. */
  baseUrl: string;
  requests: FakeImagesRequest[];
  /** What a generation answers; `b64` by default. */
  answer: "b64" | "url";
  /** When set, generations and edits answer it (status and JSON). */
  failure: { status: number; body: unknown } | null;
  models: string[];
  stop(): Promise<void>;
}

export const FAKE_IMAGE = noisePng(3, 2);
export const FAKE_IMAGE_BASE64 = Buffer.from(FAKE_IMAGE).toString("base64");

export function startFakeOpenAiImages(): FakeImagesServer {
  const stored = new Map<string, Uint8Array>();
  const fake: FakeImagesServer = {
    baseUrl: "",
    requests: [],
    answer: "b64",
    failure: null,
    models: ["image-one", "image-two"],
    stop: async () => { await server.stop(true); },
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const authorization = req.headers.get("authorization");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        fake.requests.push({ path: url.pathname, authorization, body: {} });
        return Response.json({ object: "list", data: fake.models.map(id => ({ id, object: "model" })) });
      }
      const content = /^\/v1\/images\/([\w-]+)\/content$/.exec(url.pathname);
      if (req.method === "GET" && content) {
        const bytes = stored.get(content[1]!);
        return bytes ? new Response(Buffer.from(bytes), { headers: { "content-type": "image/png" } }) : new Response("gone", { status: 404 });
      }
      if (req.method !== "POST" || (url.pathname !== "/v1/images/generations" && url.pathname !== "/v1/images/edits")) {
        return new Response("not found", { status: 404 });
      }
      const body: Record<string, unknown> = {};
      if (url.pathname.endsWith("/edits")) {
        const form = await req.formData();
        for (const [key, value] of form.entries()) {
          const file: unknown = value;
          const entry = file instanceof File ? { file: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) } : value;
          body[key] = key in body ? [body[key], entry].flat() : entry;
        }
      } else {
        Object.assign(body, await req.json());
      }
      fake.requests.push({ path: url.pathname, authorization, body });
      if (fake.failure) return Response.json(fake.failure.body, { status: fake.failure.status });
      const count = typeof body.n === "number" ? body.n : Number(body.n ?? 1);
      const data = Array.from({ length: count }, () => {
        if (fake.answer === "b64") return { b64_json: FAKE_IMAGE_BASE64, revised_prompt: `revised ${String(body.prompt)}` };
        const id = crypto.randomUUID();
        stored.set(id, FAKE_IMAGE);
        return { b64_json: null, url: `/v1/images/${id}/content`, revised_prompt: String(body.prompt) };
      });
      return Response.json({ created: 0, data });
    },
  });
  fake.baseUrl = `http://127.0.0.1:${server.port}/v1`;
  return fake;
}
