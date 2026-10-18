import { beforeEach, expect, test } from "bun:test";
import { getDb } from "../../injected-process-state.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { AttachmentCache, hydratePrompt, materializePromptAttachments } from "../../session-runtime/attachments.js";
import { createProject } from "../project-fixture.js";
import { createSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();

const bytes = Buffer.from("image bytes");
let image: { type: "image"; attachmentId: string; mimeType: string; byteSize: number; sha256: string };
beforeEach(() => {
  const projectId = createProject("Attachments", "/tmp/attachments").id;
  createSession("session", projectId, { agentRuntimeType: "pi" });
  createSession("other", projectId, { agentRuntimeType: "pi" });
  const { id, mimeType, byteSize, sha256 } = storeSessionAttachment("session", { data: bytes, mimeType: "image/png" });
  image = { type: "image", attachmentId: id, mimeType, byteSize, sha256 };
});

/** The store loses the attachment's bytes (pruned). */
const prune = (attachmentId: string) => getDb().query("UPDATE session_attachments SET data = NULL, pruned_at = 'now' WHERE id = ?").run(attachmentId);
const hydrated = { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" };

test("materializes a prompt's attachments before admission; hydration then reads the cache, not the store", () => {
  const cache = new AttachmentCache();
  const content = [{ type: "text" as const, text: "see this" }, image];
  materializePromptAttachments(cache, "session", content);
  prune(image.attachmentId);
  expect(hydratePrompt(cache, "session", content)).toEqual([{ type: "text", text: "see this" }, hydrated]);
  // A cached attachment is checked against each reference too.
  expect(() => hydratePrompt(cache, "session", [{ ...image, sha256: "0".repeat(64) }])).toThrow("metadata mismatch");
});

test("hydration reads a cache miss from the store and caches it; one the store no longer holds becomes a placeholder", () => {
  const cache = new AttachmentCache();
  const pruned = storeSessionAttachment("session", { data: Buffer.from("other bytes"), mimeType: "image/png" });
  prune(pruned.id);
  expect(hydratePrompt(cache, "session", [image, { ...image, attachmentId: "gone" }, { ...image, attachmentId: pruned.id }])).toEqual([
    hydrated, { type: "text", text: "[Image attachment missing]" }, { type: "text", text: "[Image attachment missing]" },
  ]);
  prune(image.attachmentId);
  expect(hydratePrompt(cache, "session", [image])).toEqual([hydrated]);
  // Per session: another session does not hold it.
  expect(hydratePrompt(cache, "other", [image])).toEqual([{ type: "text", text: "[Image attachment missing]" }]);
});

test("rejects a prompt naming attachments the store does not hold, or whose stored metadata does not match", () => {
  const cache = new AttachmentCache();
  expect(() => materializePromptAttachments(cache, "session", [image, { ...image, attachmentId: "att-2" }])).toThrow("unavailable");
  expect(() => materializePromptAttachments(cache, "other", [image])).toThrow("unavailable");
  expect(() => materializePromptAttachments(cache, "session", [{ ...image, sha256: "0".repeat(64) }])).toThrow("metadata mismatch");
  expect(() => materializePromptAttachments(cache, "session", [{ ...image, byteSize: bytes.length + 1 }])).toThrow("metadata mismatch");
  expect(() => materializePromptAttachments(cache, "session", [{ ...image, mimeType: "image/jpeg" }])).toThrow("metadata mismatch");
  expect(() => materializePromptAttachments(cache, "session", [image, { ...image, mimeType: "image/jpeg" }])).toThrow("conflicting");

  const pruned = storeSessionAttachment("session", { data: Buffer.from("other bytes"), mimeType: "image/png" });
  prune(pruned.id);
  expect(() => materializePromptAttachments(new AttachmentCache(), "session", [{ ...image, attachmentId: pruned.id, byteSize: pruned.byteSize, sha256: pruned.sha256 }])).toThrow("unavailable");
});
