import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AttachmentCache, hydratePrompt, materializePromptAttachments, type FetchAttachment } from "./node-attachments.js";

const bytes = Buffer.from("image bytes");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const image = { type: "image" as const, attachmentId: "att-1", mimeType: "image/png", byteSize: bytes.length, sha256 };
const served = { data: bytes, mimeType: "image/png", byteSize: bytes.length, sha256 };

test("materializes verified attachment bytes before admission; hydration then reads the cache without a fetch", async () => {
  const cache = new AttachmentCache();
  const content = [{ type: "text" as const, text: "see this" }, image];
  await materializePromptAttachments(cache, "session", content, async (sessionId, attachmentId) => {
    expect([sessionId, attachmentId]).toEqual(["session", "att-1"]);
    return served;
  });
  expect(cache.get("session", "att-1")?.data).toEqual(bytes);
  expect(await hydratePrompt(cache, "session", content, async () => { throw new Error("unexpected fetch"); })).toEqual([
    { type: "text", text: "see this" }, { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
  ]);
});

test("hydration fetches a cache miss from the server once and caches it; one the server no longer holds becomes a placeholder", async () => {
  const cache = new AttachmentCache();
  const fetched: string[] = [];
  const fetch: FetchAttachment = async (_sessionId, attachmentId) => { fetched.push(attachmentId); return attachmentId === "att-1" ? served : null; };
  const content = [image, { ...image, attachmentId: "gone" }];
  expect(await hydratePrompt(cache, "session", content, fetch)).toEqual([
    { type: "image", data: bytes.toString("base64"), mimeType: "image/png" }, { type: "text", text: "[Image attachment missing]" },
  ]);
  await hydratePrompt(cache, "session", [image], fetch);
  expect(fetched).toEqual(["att-1", "gone"]);
  // Cached per session: another session fetches its own.
  expect(cache.get("other", "att-1")).toBeNull();
});

test("a missing later image leaves the verified cache intact without admitting the prompt", async () => {
  const cache = new AttachmentCache();
  const missing = { ...image, attachmentId: "att-2" };
  await expect(materializePromptAttachments(cache, "session", [image, missing], async (_sessionId, attachmentId) =>
    attachmentId === "att-1" ? served : null,
  )).rejects.toThrow("unavailable");
  expect(cache.get("session", "att-1")?.data).toEqual(bytes);
  expect(cache.get("session", "att-2")).toBeNull();
});

test("rejects mismatched or unavailable bytes without caching unverified images", async () => {
  const cache = new AttachmentCache();
  await expect(materializePromptAttachments(cache, "session", [image], async () => null)).rejects.toThrow("unavailable");
  await expect(materializePromptAttachments(cache, "session", [image], async () => ({ ...served, data: Buffer.alloc(bytes.length) }))).rejects.toThrow("checksum");
  await expect(materializePromptAttachments(cache, "session", [image, { ...image, mimeType: "image/jpeg" }], async () => ({
    ...served, mimeType: "image/jpeg",
  }))).rejects.toThrow("conflicting");
  expect(cache.get("session", "att-1")).toBeNull();
});
