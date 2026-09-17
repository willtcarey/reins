import { describe, expect, test, beforeEach } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { createProject } from "../project-store.js";
import { createSession } from "../session-store.js";
import {
  collectAttachmentIds,
  externalizeRuntimeContentBlock,
  getSessionAttachment,
  hydrateImageAttachmentBlock,
  storeSessionAttachment,
} from "../session-attachments-store.js";

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

    const externalizedImage = externalizeRuntimeContentBlock("sess-attachments", inline);
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

  test("externalizes inline image runtime content blocks", () => {
    const imageData = Buffer.from("shared runtime image").toString("base64");

    const textBlock = externalizeRuntimeContentBlock("sess-attachments", { type: "text", text: "see this" });
    const imageBlock = externalizeRuntimeContentBlock("sess-attachments", {
      type: "image",
      data: imageData,
      mimeType: "image/png",
      filename: "shared.png",
    });

    expect(textBlock).toEqual({ type: "text", text: "see this" });
    expect(imageBlock).toMatchObject({
      type: "image",
      mimeType: "image/png",
      filename: "shared.png",
      byteSize: Buffer.from("shared runtime image").length,
    });
    expect(imageBlock).not.toHaveProperty("data");
  });

});
