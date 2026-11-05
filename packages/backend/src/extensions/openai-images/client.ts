/**
 * Requests to an OpenAI-compatible images API: `GET /models`, `POST /images/generations` (JSON) and
 * `POST /images/edits` (multipart). It works with OpenAI and with servers that copy its API (SGLang).
 */

import type { ImageBlock, ImageRequest, ImageResult } from "@reins/sdk/server";
import type { Endpoint } from "./endpoints.js";

const LIST_TIMEOUT_MS = 15_000;
/** A large image on a slow server takes minutes; the script's signal ends it sooner. */
const GENERATE_TIMEOUT_MS = 5 * 60_000;

/** `path` under the base URL, which may or may not end with `/`. */
const urlOf = (endpoint: Endpoint, path: string) => `${endpoint.baseUrl.replace(/\/+$/, "")}/${path}`;

const authorization = (endpoint: Endpoint): Record<string, string> => endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Fetch, with the endpoint's name on every failure, and the server's own message for an HTTP error. */
async function request(endpoint: Endpoint, url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
  } catch (error) {
    throw new Error(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (response.ok) return response;
  const text = await response.text().catch(() => "");
  throw new Error(`${endpoint.name}: HTTP ${response.status}: ${serverMessage(text) || response.statusText}`);
}

/** OpenAI's `{ error: { message } }`, FastAPI's `{ detail }`, or the text itself. */
function serverMessage(text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body)) {
      const { error, detail, message } = body;
      if (isRecord(error) && typeof error.message === "string") return error.message;
      if (typeof error === "string") return error;
      if (typeof message === "string") return message;
      if (detail !== undefined) return typeof detail === "string" ? detail : JSON.stringify(detail);
    }
  } catch {
    // Not JSON: the text as it is.
  }
  return text.trim().slice(0, 500);
}

/** The model IDs the server lists. */
export async function listModels(endpoint: Endpoint, signal: AbortSignal): Promise<string[]> {
  const response = await request(endpoint, urlOf(endpoint, "models"), { headers: authorization(endpoint) }, signal, LIST_TIMEOUT_MS);
  const body: unknown = await response.json();
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : null;
  if (!data) throw new Error(`${endpoint.name}: GET /models gave no data list`);
  return data.flatMap(model => isRecord(model) && typeof model.id === "string" ? [model.id] : []);
}

/** The MIME type the bytes start with; the server's, else PNG, when they say nothing. */
function sniffMimeType(bytes: Uint8Array, fallback: string | null): string {
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return fallback?.startsWith("image/") ? fallback.split(";")[0]!.trim() : "image/png";
}

const extensionOf = (mimeType: string) => mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";

/** A multipart field's value: strings as they are, other values as JSON. */
const formValue = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

/**
 * Makes images with `model`: a generation without images, an edit with them. The body is the endpoint's
 * default parameters, then the request's, then what Reins sets (model, prompt, n, size), then a random
 * `seed` when the endpoint asks for one and the request has none (said in the result's text). No
 * `response_format` is sent (OpenAI's gpt-image models refuse it): each image is read from `b64_json`, else
 * fetched from `url` (SGLang answers a path relative to the server).
 */
export async function generate(endpoint: Endpoint, model: string, input: ImageRequest, signal: AbortSignal): Promise<ImageResult> {
  const fields: Record<string, unknown> = {
    ...endpoint.defaultParameters, ...input.parameters, model, prompt: input.prompt,
    ...(input.count !== undefined ? { n: input.count } : {}),
    ...(input.size !== undefined ? { size: input.size } : {}),
  };
  const randomSeed = endpoint.randomSeed && fields.seed === undefined ? crypto.getRandomValues(new Uint32Array(1))[0]! >>> 1 : undefined;
  if (randomSeed !== undefined) fields.seed = randomSeed;
  const images = input.images ?? [];
  let init: RequestInit;
  if (images.length === 0) {
    init = { method: "POST", headers: { ...authorization(endpoint), "Content-Type": "application/json" }, body: JSON.stringify(fields) };
  } else {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) if (value !== undefined && value !== null) form.append(key, formValue(value));
    const field = images.length === 1 ? "image" : "image[]";
    images.forEach((image, i) => {
      form.append(field, new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType }), `image-${i + 1}.${extensionOf(image.mimeType)}`);
    });
    init = { method: "POST", headers: authorization(endpoint), body: form };
  }
  const path = images.length === 0 ? "images/generations" : "images/edits";
  const response = await request(endpoint, urlOf(endpoint, path), init, signal, GENERATE_TIMEOUT_MS);
  const body: unknown = await response.json();
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : null;
  if (!data || data.length === 0) throw new Error(`${endpoint.name}: POST /${path} gave no images`);

  const blocks: ImageBlock[] = [];
  const texts: string[] = [];
  for (const item of data) {
    if (!isRecord(item)) continue;
    if (typeof item.revised_prompt === "string" && item.revised_prompt !== input.prompt) texts.push(item.revised_prompt);
    if (typeof item.b64_json === "string" && item.b64_json) {
      blocks.push({ type: "image", data: item.b64_json, mimeType: sniffMimeType(Buffer.from(item.b64_json.slice(0, 24), "base64"), null) });
    } else if (typeof item.url === "string" && item.url) {
      const url = new URL(item.url, `${endpoint.baseUrl.replace(/\/+$/, "")}/`);
      // The key goes only to the endpoint's own server, not to a storage URL elsewhere.
      const headers = url.origin === new URL(endpoint.baseUrl).origin ? authorization(endpoint) : {};
      const image = await request(endpoint, url.href, { headers }, signal, GENERATE_TIMEOUT_MS);
      const bytes = new Uint8Array(await image.arrayBuffer());
      blocks.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: sniffMimeType(bytes, image.headers.get("content-type")) });
    }
  }
  if (blocks.length === 0) throw new Error(`${endpoint.name}: POST /${path} gave neither b64_json nor url`);
  // So an image the model wants again can be made again: it gives the seed back in `parameters`.
  const lines = [...new Set(texts), ...(randomSeed !== undefined ? [`Seed: ${randomSeed}`] : [])];
  return { images: blocks, ...(lines.length > 0 ? { text: lines.join("\n") } : {}) };
}
