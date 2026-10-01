import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AttachmentCache, materializePromptAttachments, type AttachmentBytes } from "../node-attachments.js";
import { MAX_ATTACHMENT_BYTES } from "@reins/node-protocol";
import { toolImageReferences, type UploadAttachment } from "./tool-images.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sha256 = createHash("sha256").update(png).digest("hex");
const inline = (mimeType = "image/png") => ({ type: "image", data: png.toString("base64"), mimeType });

const idOf = (block: unknown) => typeof block === "object" && block !== null && "attachmentId" in block ? String(block.attachmentId) : "";
/** An upload that records what it stores (session, node-assigned ID, bytes). */
function recordingUpload() {
  const uploads: Array<{ sessionId: string; attachmentId: string; attachment: AttachmentBytes }> = [];
  const upload: UploadAttachment = async (sessionId, attachmentId, attachment) => { uploads.push({ sessionId, attachmentId, attachment }); };
  return { uploads, upload };
}

test("the after_tool hook uploads each new image once, before returning its reference; identical bytes reuse it", async () => {
  const cache = new AttachmentCache();
  const { uploads, upload } = recordingUpload();
  const hook = toolImageReferences(cache, upload, "s");
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
  // A later tool result with the same image reuses it too, with no second upload.
  expect(await hook([inline()])).toEqual([{ ...reference, attachmentId: id }]);
  expect(uploads).toEqual([{ sessionId: "s", attachmentId: id, attachment: expect.objectContaining({ mimeType: "image/png", byteSize: png.length, sha256 }) }]);
  expect(Buffer.from(uploads[0]!.attachment.data)).toEqual(png);
  expect(cache.get("s", id)?.sha256).toBe(sha256);
});

test("an image identical to a materialized prompt attachment reuses the server's ID with no upload", async () => {
  const cache = new AttachmentCache();
  const { uploads, upload } = recordingUpload();
  await materializePromptAttachments(cache, "s", [{ type: "image", attachmentId: "server-img", mimeType: "image/png", byteSize: png.length, sha256 }],
    async () => ({ data: new Uint8Array(png), mimeType: "image/png", byteSize: png.length, sha256, filename: "shot.png" }));
  expect(await toolImageReferences(cache, upload, "s")([{ ...inline(), width: 1, height: 1 }])).toEqual([
    { type: "image", attachmentId: "server-img", mimeType: "image/png", byteSize: png.length, sha256, filename: "shot.png" },
  ]);
  expect(uploads).toEqual([]);
});

test("the same bytes under a different MIME type or in another session get their own attachment", async () => {
  const cache = new AttachmentCache();
  const { uploads, upload } = recordingUpload();
  const [png1, jpeg] = (await toolImageReferences(cache, upload, "s")([inline(), inline("image/jpeg")]))!;
  const [other] = (await toolImageReferences(cache, upload, "t")([inline()]))!;
  expect(new Set([idOf(png1), idOf(jpeg), idOf(other)]).size).toBe(3);
  expect(uploads.map(({ sessionId, attachmentId }) => [sessionId, attachmentId])).toEqual([["s", idOf(png1)], ["s", idOf(jpeg)], ["t", idOf(other)]]);
});

test("images the server would not hold are never referenced: rejected ones and failed uploads become text notes", async () => {
  const cache = new AttachmentCache();
  const { uploads, upload } = recordingUpload();
  expect(await toolImageReferences(cache, upload, "s")([
    inline("image/tiff"),
    { type: "image", data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"), mimeType: "image/png" },
    { type: "image", data: "", mimeType: "image/png" },
  ])).toEqual([
    { type: "text", text: "[Image omitted: unsupported type image/tiff]" },
    { type: "text", text: "[Image omitted: larger than 10 MiB]" },
    { type: "text", text: "[Image omitted: empty]" },
  ]);
  expect(uploads).toEqual([]);

  const failing = toolImageReferences(cache, async () => { throw new Error("link down"); }, "s");
  expect(await failing([inline()])).toEqual([{ type: "text", text: "[Image omitted: upload failed: link down]" }]);
  // Nothing was cached, so a later result with the same image uploads it again.
  const [retried] = (await toolImageReferences(cache, upload, "s")([inline()]))!;
  expect(uploads.map(({ attachmentId }) => attachmentId)).toEqual([idOf(retried)]);
});
