/**
 * What an `execute` script gives the model besides its return value: `text(value)` and `image(...items)`
 * add content blocks in call order (docs/features/scripting.md *Output*).
 */

import { fitImage, formatMiB } from "../session-runtime/provider-images.js";

export type ScriptImageBlock = { type: "image"; data: string; mimeType: string };
export type ScriptContentBlock = { type: "text"; text: string } | ScriptImageBlock;

/** Each image stays in the session's history and is sent with every later request: a few are enough. */
export const MAX_SCRIPT_IMAGES = 10;

/** As the model gets a value: strings as they are, other values as JSON. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

/**
 * The images in `value`: `{ data, mimeType }` (data base64 or bytes; an image block is one), an object with
 * `images` (`api.images.generate`'s result) or `content` (a tool's result), or an array of these. Values come
 * from the script's vm, so nothing is checked with `instanceof`.
 */
export function collectImages(value: unknown): ScriptImageBlock[] {
  if (Array.isArray(value)) return value.flatMap(collectImages);
  if (typeof value !== "object" || value === null) throw new Error(`not an image: ${formatValue(value).slice(0, 80)}`);
  if ("data" in value) {
    const { data } = value;
    const mimeType = "mimeType" in value ? value.mimeType : undefined;
    if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) throw new Error("an image needs a mimeType such as \"image/png\"");
    if (typeof data === "string") return [{ type: "image", data, mimeType }];
    if (ArrayBuffer.isView(data)) return [{ type: "image", data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"), mimeType }];
    throw new Error("an image's data is base64 or a Uint8Array");
  }
  if ("images" in value && Array.isArray(value.images)) return collectImages(value.images);
  if ("content" in value && Array.isArray(value.content)) return collectImages(value.content.filter(block => block?.type === "image"));
  throw new Error("not an image: give { data, mimeType }, an api.images.generate result or a tool result");
}

/** Scaled down as `read` does, with Pi's note when it was; a note in its place when it cannot fit. */
async function fitted(image: ScriptImageBlock): Promise<ScriptContentBlock[]> {
  const bytes = Buffer.from(image.data, "base64");
  const fit = await fitImage(bytes, image.mimeType).catch(() => null);
  if (!fit) return [{ type: "text", text: `[Image omitted: ${formatMiB(bytes.byteLength)} is over the provider's image size limit, and it could not be resized.]` }];
  return [{ type: "image", data: fit.data, mimeType: fit.mimeType }, ...fit.hints.map(text => ({ type: "text" as const, text }))];
}

/** One script's output: the globals it gets, and the blocks they added, once the script ended. */
export function scriptOutput() {
  const parts: ScriptContentBlock[] = [];
  let images = 0;
  return {
    globals: {
      text(value: unknown): void {
        parts.push({ type: "text", text: formatValue(value) });
      },
      image(...items: unknown[]): void {
        let found: ScriptImageBlock[];
        try {
          found = collectImages(items);
        } catch (error) {
          throw new Error(`image(): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        if (found.length === 0) throw new Error("image(): no image in what it was given");
        if (images + found.length > MAX_SCRIPT_IMAGES) throw new Error(`image(): at most ${MAX_SCRIPT_IMAGES} images in a script`);
        images += found.length;
        parts.push(...found);
      },
    },
    /** One at a time, as Bun has crashed when many resizer workers were cut off at once. */
    async blocks(): Promise<ScriptContentBlock[]> {
      const blocks: ScriptContentBlock[] = [];
      for (const part of parts) blocks.push(...part.type === "text" ? [part] : await fitted(part));
      return blocks;
    },
  };
}
