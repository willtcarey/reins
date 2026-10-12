import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MAX_ATTACHMENT_BYTES } from "../../session-attachments-store.js";
import { AttachmentCache, materializePromptAttachments } from "../../session-runtime/attachments.js";
import { toolImageReferences, type StoreAttachment } from "../../session-runtime/tool-images.js";
import type { AttachmentBytes } from "../../session-runtime/attachments.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sha256 = createHash("sha256").update(png).digest("hex");
const inline = (mimeType = "image/png") => ({ type: "image", data: png.toString("base64"), mimeType });

const idOf = (block: unknown) => typeof block === "object" && block !== null && "attachmentId" in block ? String(block.attachmentId) : "";
/** An attachment store that records what it stores (session, runtime-assigned ID, bytes). */
function recordingStore() {
  const stored: Array<{ sessionId: string; attachmentId: string; attachment: AttachmentBytes }> = [];
  const store: StoreAttachment = async (sessionId, attachmentId, attachment) => { stored.push({ sessionId, attachmentId, attachment }); };
  return { stored, store };
}

test("the after_tool hook stores each new image once, before returning its reference; identical bytes reuse it", async () => {
  const cache = new AttachmentCache();
  const { stored, store } = recordingStore();
  const hook = toolImageReferences(cache, store, "s");
  expect(await hook([{ type: "text", text: "no images" }])).toBeUndefined();

  const content = await hook([
    { type: "text", text: "Read image" },
    { ...inline(), width: 1, height: 1 },
    { ...inline(), filename: "later.png" },
  ]);
  // Identical bytes and MIME type reuse the first reference, including its hints (the cached metadata).
  const reference = { type: "image", attachmentId: expect.stringMatching(/^att_[0-9a-f-]{36}$/), mimeType: "image/png", byteSize: png.length, sha256, width: 1, height: 1 };
  expect(content).toEqual([{ type: "text", text: "Read image" }, reference, reference]);
  const id = idOf(content![1]);
  expect(idOf(content![2])).toBe(id);
  // A later tool result with the same image reuses it too, stored once.
  expect(await hook([inline()])).toEqual([{ ...reference, attachmentId: id }]);
  expect(stored).toEqual([{ sessionId: "s", attachmentId: id, attachment: expect.objectContaining({ mimeType: "image/png", byteSize: png.length, sha256 }) }]);
  expect(Buffer.from(stored[0]!.attachment.data)).toEqual(png);
  expect(cache.get("s", id)?.sha256).toBe(sha256);
});

test("an image identical to a materialized prompt attachment reuses its ID, storing nothing", async () => {
  const cache = new AttachmentCache();
  const { stored, store } = recordingStore();
  await materializePromptAttachments(cache, "s", [{ type: "image", attachmentId: "server-img", mimeType: "image/png", byteSize: png.length, sha256 }],
    async () => ({ data: new Uint8Array(png), mimeType: "image/png", byteSize: png.length, sha256, filename: "shot.png" }));
  expect(await toolImageReferences(cache, store, "s")([{ ...inline(), width: 1, height: 1 }])).toEqual([
    { type: "image", attachmentId: "server-img", mimeType: "image/png", byteSize: png.length, sha256, filename: "shot.png" },
  ]);
  expect(stored).toEqual([]);
});

test("the same bytes under a different MIME type or in another session get their own attachment", async () => {
  const cache = new AttachmentCache();
  const { stored, store } = recordingStore();
  const [png1, jpeg] = (await toolImageReferences(cache, store, "s")([inline(), inline("image/jpeg")]))!;
  const [other] = (await toolImageReferences(cache, store, "t")([inline()]))!;
  expect(new Set([idOf(png1), idOf(jpeg), idOf(other)]).size).toBe(3);
  expect(stored.map(({ sessionId, attachmentId }) => [sessionId, attachmentId])).toEqual([["s", idOf(png1)], ["s", idOf(jpeg)], ["t", idOf(other)]]);
});

test("images the store would not hold are never referenced: rejected ones and failed stores become text notes", async () => {
  const cache = new AttachmentCache();
  const { stored, store } = recordingStore();
  expect(await toolImageReferences(cache, store, "s")([
    inline("image/tiff"),
    { type: "image", data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"), mimeType: "image/png" },
    { type: "image", data: "", mimeType: "image/png" },
  ])).toEqual([
    { type: "text", text: "[Image omitted: unsupported type image/tiff]" },
    { type: "text", text: "[Image omitted: larger than 10 MiB]" },
    { type: "text", text: "[Image omitted: empty]" },
  ]);
  expect(stored).toEqual([]);

  const failing = toolImageReferences(cache, async () => { throw new Error("database locked"); }, "s");
  expect(await failing([inline()])).toEqual([{ type: "text", text: "[Image omitted: storing it failed: database locked]" }]);
  // Nothing was cached, so a later result with the same image stores it again.
  const [retried] = (await toolImageReferences(cache, store, "s")([inline()]))!;
  expect(stored.map(({ attachmentId }) => attachmentId)).toEqual([idOf(retried)]);
});
