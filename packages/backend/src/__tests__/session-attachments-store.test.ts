import { describe, expect, test, beforeEach } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { createProject } from "../project-store.js";
import { createSession } from "../session-store.js";
import {
  collectAttachmentIds,
  externalizeInlineImageBlock,
  getSessionAttachment,
  hydrateImageAttachmentBlock,
  storeSessionAttachment,
} from "../session-attachments-store.js";
import { appendMessages, loadMessages, loadMessagesForLLM, persistMessages } from "../messages-store.js";

let projectId: number;

describe("session attachments", () => {
  useTestDb();

  beforeEach(() => {
    const project = createProject("Attachment Project", "/tmp/attachment-project");
    projectId = project.id;
    createSession("sess-attachments", projectId, { agentRuntimeType: "pi" });
  });

  test("stores image bytes content-addressed per session", () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const first = storeSessionAttachment("sess-attachments", {
      data: bytes,
      mimeType: "image/png",
      filename: "a.png",
    });
    const second = storeSessionAttachment("sess-attachments", {
      data: bytes,
      mimeType: "image/png",
      filename: "a-copy.png",
    });

    expect(second.id).toBe(first.id);
    expect(second.sha256).toBe(first.sha256);
    expect(second.byteSize).toBe(4);

    const stored = getSessionAttachment("sess-attachments", first.id);
    expect(stored?.data?.toString("hex")).toBe(bytes.toString("hex"));
  });

  test("externalizes inline image blocks and hydrates refs back to runtime blocks", () => {
    const inline = { type: "image" as const, data: Buffer.from("hello").toString("base64"), mimeType: "image/png", filename: "shot.png", width: 320, height: 200 };

    const externalizedImage = externalizeInlineImageBlock("sess-attachments", inline);
    if (!("attachmentId" in externalizedImage) || typeof externalizedImage.attachmentId !== "string") {
      throw new Error("Expected externalized image attachment ref");
    }
    expect(externalizedImage.attachmentId).toStartWith("att_");
    expect("data" in externalizedImage).toBe(false);
    expect(externalizedImage).toMatchObject({ width: 320, height: 200 });
    expect(collectAttachmentIds({ content: [{ type: "text", text: "look" }, externalizedImage] })).toEqual([externalizedImage.attachmentId]);

    const hydrated = hydrateImageAttachmentBlock("sess-attachments", externalizedImage);
    expect(hydrated).toMatchObject({
      type: "image",
      data: Buffer.from("hello").toString("base64"),
      mimeType: "image/png",
      filename: "shot.png",
      width: 320,
      height: 200,
    });
  });

  test("appendMessages persists refs while loadMessagesForLLM hydrates inline images", () => {
    const imageData = Buffer.from("runtime image").toString("base64");
    appendMessages("sess-attachments", [
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read",
        isError: false,
        content: [{ type: "image", data: imageData, mimeType: "image/png" }],
      },
    ]);

    const visible = loadMessages("sess-attachments");
    expect(visible[0].content[0].attachmentId).toStartWith("att_");
    expect(visible[0].content[0].data).toBeUndefined();

    const runtime = loadMessagesForLLM("sess-attachments");
    expect(runtime[0].content[0]).toMatchObject({
      type: "image",
      data: imageData,
      mimeType: "image/png",
    });
  });

  test("compaction pruning clears unreferenced attachment bytes", () => {
    const imageData = Buffer.from("prune me").toString("base64");
    appendMessages("sess-attachments", [
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read",
        isError: false,
        content: [{ type: "image", data: imageData, mimeType: "image/png" }],
      },
    ]);

    const visible = loadMessages("sess-attachments");
    const image = visible[0].content[0];
    if (!("attachmentId" in image) || typeof image.attachmentId !== "string") {
      throw new Error("Expected attachment ref before pruning");
    }

    appendMessages("sess-attachments", [
      { role: "compactionSummary", summary: "summary" },
    ]);

    const pruned = getSessionAttachment("sess-attachments", image.attachmentId);
    expect(pruned?.data).toBeNull();
    expect(pruned?.pruned_at).toEqual(expect.any(String));
  });

  test("re-compaction prunes tool-result attachment bytes from historical rows", () => {
    const imageData = Buffer.from("delete me").toString("base64");
    persistMessages("sess-attachments", [
      { role: "compactionSummary", summary: "summary 1" },
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read",
        isError: false,
        content: [{ type: "image", data: imageData, mimeType: "image/png" }],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);

    const visible = loadMessages("sess-attachments");
    const image = visible[1].content[0];
    if (!("attachmentId" in image) || typeof image.attachmentId !== "string") {
      throw new Error("Expected post-compaction attachment ref before re-compaction");
    }

    persistMessages("sess-attachments", [
      { role: "compactionSummary", summary: "summary 2" },
    ]);

    const pruned = getSessionAttachment("sess-attachments", image.attachmentId);
    expect(pruned?.data).toBeNull();
    expect(pruned?.pruned_at).toEqual(expect.any(String));
  });

  test("re-compaction preserves attachment bytes from retained non-tool messages", () => {
    const imageData = Buffer.from("keep me").toString("base64");
    persistMessages("sess-attachments", [
      { role: "compactionSummary", summary: "summary 1" },
      {
        role: "user",
        content: [{ type: "image", data: imageData, mimeType: "image/png" }],
      },
    ]);

    const visible = loadMessages("sess-attachments");
    const image = visible[1].content[0];
    if (!("attachmentId" in image) || typeof image.attachmentId !== "string") {
      throw new Error("Expected post-compaction attachment ref before re-compaction");
    }

    persistMessages("sess-attachments", [
      { role: "compactionSummary", summary: "summary 2" },
    ]);

    const retained = getSessionAttachment("sess-attachments", image.attachmentId);
    expect(retained?.data?.toString("base64")).toBe(imageData);
    expect(retained?.pruned_at).toBeNull();
  });
});
