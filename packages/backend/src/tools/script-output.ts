/**
 * What an `execute` script gives the model besides its return value: `text(value)` and `image(...items)`
 * add content blocks in call order (docs/features/scripting.md *Output*).
 */

import { fitImage, formatMiB } from "../session-runtime/provider-images.js";

export type ScriptTextBlock = { type: "text"; text: string };
export type ScriptImageBlock = { type: "image"; data: string; mimeType: string };
export type ScriptContentBlock = ScriptTextBlock | ScriptImageBlock;

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The images in `value`, as base64 blocks, in order: an image block or `{ data, mimeType }` (`data` base64 or
 * bytes), an object with `images` (`api.images.generate`'s result), one with `content` (a tool's result: its
 * image blocks only), or an array of these. Throws for anything else. Values come from a script's vm, so
 * nothing is checked with `instanceof`.
 */
export function collectImages(value: unknown): ScriptImageBlock[] {
  if (Array.isArray(value)) return value.flatMap(collectImages);
  if (!isRecord(value)) throw new Error(`not an image: ${formatValue(value).slice(0, 80)}`);
  if ("data" in value) {
    const { data, mimeType } = value;
    if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) throw new Error("an image needs a mimeType such as \"image/png\"");
    if (typeof data === "string") return [{ type: "image", data, mimeType }];
    if (ArrayBuffer.isView(data)) return [{ type: "image", data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"), mimeType }];
    throw new Error("an image's data is base64 or a Uint8Array");
  }
  if (Array.isArray(value.images)) return collectImages(value.images);
  if (Array.isArray(value.content)) return collectImages(value.content.filter(block => isRecord(block) && block.type === "image"));
  throw new Error("not an image: give { data, mimeType }, an image block, an api.images.generate result or a tool result");
}

/** The blocks of one image the model can take: scaled down as `read` does, with Pi's note when it was;
 * a note in its place when it cannot be made to fit. */
async function fitted(image: ScriptImageBlock): Promise<ScriptContentBlock[]> {
  const bytes = Buffer.from(image.data, "base64");
  const fit = await fitImage(bytes, image.mimeType).catch(() => null);
  if (!fit) return [{ type: "text", text: `[Image omitted: ${formatMiB(bytes.byteLength)} is over the provider's image size limit, and it could not be resized.]` }];
  return [{ type: "image", data: fit.data, mimeType: fit.mimeType }, ...fit.hints.map(text => ({ type: "text" as const, text }))];
}

/** One script's output: the globals it gets, and the blocks they added, once the script ended. */
export function scriptOutput() {
  const parts: (ScriptTextBlock | ScriptImageBlock)[] = [];
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
    /** Fitting starts a resizer worker per image: only for a script that ended well, and one at a time, as
     * Bun has crashed when many were cut off at once. */
    async blocks(): Promise<ScriptContentBlock[]> {
      const blocks: ScriptContentBlock[] = [];
      for (const part of parts) blocks.push(...part.type === "text" ? [part] : await fitted(part));
      return blocks;
    },
  };
}
