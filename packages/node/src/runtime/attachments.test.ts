import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { bindNodeSession } from "../storage.js";
import { runNodeMigrations } from "../migrations.js";
import { hydrateCachedPrompt, materializePromptAttachments } from "./attachments.js";

const bytes = Buffer.from("image bytes");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const image = { type: "image" as const, attachmentId: "att-1", mimeType: "image/png", byteSize: bytes.length, sha256 };

function nodeDb(): Database {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  bindNodeSession(db, "session", { sourceId: 1, cwd: "/repo", createdAt: "2026-01-01", parentSessionId: null });
  return db;
}

test("materializes verified attachment bytes before admission and hydrates without server access", async () => {
  const db = nodeDb();
  try {
    const content = [{ type: "text" as const, text: "see this" }, image];
    await materializePromptAttachments(db, "session", content, async (sessionId, attachmentId) => {
      expect([sessionId, attachmentId]).toEqual(["session", "att-1"]);
      return { data: bytes, mimeType: "image/png", byteSize: bytes.length, sha256 };
    });
    expect(hydrateCachedPrompt(db, "session", content)).toEqual([
      { type: "text", text: "see this" }, { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
    ]);
    expect(db.query<{ data: Buffer }, []>("SELECT data FROM node_attachments").get()?.data).toEqual(bytes);
  } finally { db.close(); }
});

test("a missing later image leaves the verified cache intact without admitting the prompt", async () => {
  const db = nodeDb();
  try {
    const missing = { ...image, attachmentId: "att-2" };
    await expect(materializePromptAttachments(db, "session", [image, missing], async (_sessionId, attachmentId) =>
      attachmentId === "att-1" ? { data: bytes, mimeType: "image/png", byteSize: bytes.length, sha256 } : null,
    )).rejects.toThrow("unavailable");
    expect(db.query<{ attachment_id: string; data: Buffer }, []>("SELECT attachment_id, data FROM node_attachments").all())
      .toEqual([{ attachment_id: "att-1", data: bytes }]);
  } finally { db.close(); }
});

test("rejects mismatched or unavailable bytes without caching unverified images", async () => {
  const db = nodeDb();
  try {
    await expect(materializePromptAttachments(db, "session", [image], async () => null)).rejects.toThrow("unavailable");
    await expect(materializePromptAttachments(db, "session", [image], async () => ({ data: Buffer.alloc(bytes.length), mimeType: "image/png", byteSize: bytes.length, sha256 }))).rejects.toThrow("checksum");
    await expect(materializePromptAttachments(db, "session", [image, { ...image, mimeType: "image/jpeg" }], async () => ({
      data: bytes, mimeType: "image/jpeg", byteSize: bytes.length, sha256,
    }))).rejects.toThrow("conflicting");
    expect(db.query("SELECT 1 FROM node_attachments").get()).toBeNull();
  } finally { db.close(); }
});
