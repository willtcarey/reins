import { beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getDb } from "../../injected-process-state.js";
import { MAX_ATTACHMENT_BYTES, storeSessionAttachment } from "../../session-attachments-store.js";
import { AttachmentCache, materializePromptAttachments } from "../../session-runtime/attachments.js";
import { toolImageReferences } from "../../session-runtime/tool-images.js";
import { createProject } from "../project-fixture.js";
import { createSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();
beforeEach(() => {
  const projectId = createProject("Tool images", "/tmp/tool-images").id;
  createSession("s", projectId, { agentRuntimeType: "pi" });
  createSession("t", projectId, { agentRuntimeType: "pi" });
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sha256 = createHash("sha256").update(png).digest("hex");
const inline = (mimeType = "image/png") => ({ type: "image", data: png.toString("base64"), mimeType });

const idOf = (block: unknown) => typeof block === "object" && block !== null && "attachmentId" in block ? String(block.attachmentId) : "";
/** The attachments the store holds, in order: session, ID, MIME type, bytes and size hint. */
const stored = () => getDb()
  .query<{ session_id: string; id: string; mime_type: string; data: Uint8Array; width: number | null }, []>("SELECT session_id, id, mime_type, data, width FROM session_attachments ORDER BY rowid")
  .all()
  .map(row => ({ sessionId: row.session_id, attachmentId: row.id, mimeType: row.mime_type, data: Buffer.from(row.data), width: row.width }));

test("the after_tool hook stores each new image once, before returning its reference; identical bytes reuse it", async () => {
  const hook = toolImageReferences(new AttachmentCache(), "s");
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
  expect(stored()).toEqual([{ sessionId: "s", attachmentId: id, mimeType: "image/png", data: png, width: 1 }]);
});

test("an image identical to a materialized prompt attachment reuses its ID, storing nothing", async () => {
  const cache = new AttachmentCache();
  const prompt = storeSessionAttachment("s", { data: png, mimeType: "image/png", filename: "shot.png" });
  materializePromptAttachments(cache, "s", [{ type: "image", attachmentId: prompt.id, mimeType: "image/png", byteSize: png.length, sha256 }]);
  expect(await toolImageReferences(cache, "s")([{ ...inline(), width: 1, height: 1 }])).toEqual([
    { type: "image", attachmentId: prompt.id, mimeType: "image/png", byteSize: png.length, sha256, filename: "shot.png" },
  ]);
  expect(stored().map(({ attachmentId }) => attachmentId)).toEqual([prompt.id]);
});

test("the same bytes under a different MIME type or in another session get their own attachment", async () => {
  const cache = new AttachmentCache();
  const [png1, jpeg] = (await toolImageReferences(cache, "s")([inline(), inline("image/jpeg")]))!;
  const [other] = (await toolImageReferences(cache, "t")([inline()]))!;
  expect(new Set([idOf(png1), idOf(jpeg), idOf(other)]).size).toBe(3);
  expect(stored().map(({ sessionId, attachmentId }) => [sessionId, attachmentId])).toEqual([["s", idOf(png1)], ["s", idOf(jpeg)], ["t", idOf(other)]]);
});

test("images the store would not hold are never referenced: rejected ones and failed stores become text notes", async () => {
  const cache = new AttachmentCache();
  expect(await toolImageReferences(cache, "s")([
    inline("image/tiff"),
    { type: "image", data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"), mimeType: "image/png" },
    { type: "image", data: "", mimeType: "image/png" },
  ])).toEqual([
    { type: "text", text: "[Image omitted: unsupported type image/tiff]" },
    { type: "text", text: "[Image omitted: larger than 10 MiB]" },
    { type: "text", text: "[Image omitted: empty]" },
  ]);
  expect(stored()).toEqual([]);

  // The store refuses an attachment of a session it does not have.
  expect(await toolImageReferences(cache, "missing")([inline()])).toEqual([
    { type: "text", text: "[Image omitted: storing it failed: FOREIGN KEY constraint failed]" },
  ]);
  // Nothing was cached, so a later result with the same image stores it again.
  createSession("missing", createProject("Later", "/tmp/later").id, { agentRuntimeType: "pi" });
  const [retried] = (await toolImageReferences(cache, "missing")([inline()]))!;
  expect(stored().map(({ attachmentId }) => attachmentId)).toEqual([idOf(retried)]);
});
