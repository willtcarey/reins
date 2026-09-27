import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { bindNodeSession, createOutboxDrain } from "../storage.js";
import { runNodeMigrations } from "../migrations.js";
import { materializePromptAttachments } from "./attachments.js";
import { MAX_ATTACHMENT_BYTES } from "../protocol/schema.js";
import { toolImageReferences } from "./tool-images.js";

const binding = { sourceId: 1, cwd: "/tmp/node", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const idOf = (block: unknown) => typeof block === "object" && block !== null && "attachmentId" in block ? String(block.attachmentId) : "";
const counts = (db: Database) => ({
  cached: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM node_attachments").get()!.n,
  uploads: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM session_outbox WHERE kind = 'attachment'").get()!.n,
});

test("the after_tool hook references inline images locally with no server: bytes cached once, upload queued once, nothing waits", () => {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  bindNodeSession(db, "s", binding);
  const hook = toolImageReferences(db, "s");
  expect(hook([{ type: "text", text: "no images" }])).toBeUndefined();

  const content = hook([
    { type: "text", text: "Read image" },
    { type: "image", data: png.toString("base64"), mimeType: "image/png", width: 1, height: 1 },
    { type: "image", data: png.toString("base64"), mimeType: "image/png", filename: "later.png" },
  ]);
  expect(content).not.toBeInstanceOf(Promise);
  const sha256 = createHash("sha256").update(png).digest("hex");
  // Identical bytes and MIME type reuse the first reference, including its hints (the cached row's metadata).
  const reference = { type: "image", attachmentId: expect.stringMatching(/^att_[0-9a-f-]{36}$/), mimeType: "image/png", byteSize: png.length, sha256, width: 1, height: 1 };
  expect(content).toEqual([{ type: "text", text: "Read image" }, reference, reference]);
  const id = idOf(content![1]);
  expect(idOf(content![2])).toBe(id);
  // A later tool result with the same image reuses it too.
  expect(hook([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }])).toEqual([{ ...reference, attachmentId: id }]);
  expect(db.query("SELECT attachment_id, data, width, filename FROM node_attachments").all())
    .toEqual([{ attachment_id: id, data: png, width: 1, filename: null }]);
  // The upload row names the cached bytes; it does not copy them.
  expect(db.query("SELECT kind, start_seq, payload FROM session_outbox ORDER BY id").all())
    .toEqual([{ kind: "attachment", start_seq: null, payload: JSON.stringify({ attachmentId: id }) }]);
  db.close();
});

test("an image whose upload was already acknowledged is reused without another upload", async () => {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  bindNodeSession(db, "s", binding);
  const hook = toolImageReferences(db, "s");
  const [first] = hook([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }])!;
  await createOutboxDrain(db, () => {})("s");
  expect(counts(db)).toEqual({ cached: 1, uploads: 0 });
  const [again] = hook([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }])!;
  expect(again).toEqual(first);
  expect(counts(db)).toEqual({ cached: 1, uploads: 0 });
  db.close();
});

test("an image identical to a materialized prompt attachment reuses the server's ID and queues no upload", async () => {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  bindNodeSession(db, "s", binding);
  const sha256 = createHash("sha256").update(png).digest("hex");
  await materializePromptAttachments(db, "s", [{ type: "image", attachmentId: "server-img", mimeType: "image/png", byteSize: png.length, sha256 }],
    async () => ({ data: new Uint8Array(png), mimeType: "image/png", byteSize: png.length, sha256, filename: "shot.png" }));
  expect(toolImageReferences(db, "s")([{ type: "image", data: png.toString("base64"), mimeType: "image/png", width: 1, height: 1 }])).toEqual([
    { type: "image", attachmentId: "server-img", mimeType: "image/png", byteSize: png.length, sha256, filename: "shot.png" },
  ]);
  expect(counts(db)).toEqual({ cached: 1, uploads: 0 });
  db.close();
});

test("the same bytes under a different MIME type or in another session get their own attachment", () => {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  bindNodeSession(db, "s", binding);
  bindNodeSession(db, "t", binding);
  const [png1, jpeg] = toolImageReferences(db, "s")([
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    { type: "image", data: png.toString("base64"), mimeType: "image/jpeg" },
  ])!;
  const [other] = toolImageReferences(db, "t")([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }])!;
  expect(new Set([idOf(png1), idOf(jpeg), idOf(other)]).size).toBe(3);
  expect(counts(db)).toEqual({ cached: 3, uploads: 3 });
  db.close();
});

test("images the server would reject are never referenced: they become text notes and queue no upload", () => {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  bindNodeSession(db, "s", binding);
  const hook = toolImageReferences(db, "s");
  expect(hook([
    { type: "image", data: png.toString("base64"), mimeType: "image/tiff" },
    { type: "image", data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"), mimeType: "image/png" },
    { type: "image", data: "", mimeType: "image/png" },
  ])).toEqual([
    { type: "text", text: "[Image omitted: unsupported type image/tiff]" },
    { type: "text", text: "[Image omitted: larger than 10 MiB]" },
    { type: "text", text: "[Image omitted: empty]" },
  ]);
  expect(db.query("SELECT COUNT(*) AS n FROM node_attachments").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM session_outbox").get()).toEqual({ n: 0 });
  db.close();
});
