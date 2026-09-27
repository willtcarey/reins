import { describe, expect, test, beforeEach } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { createProject } from "../project-store.js";
import { createSession } from "./session-fixture.js";
import {
  collectAttachmentIds,
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

  test("stores bytes under a caller-assigned ID exactly: replays converge, divergent content or foreign IDs reject", () => {
    createSession("sess-other", projectId, { agentRuntimeType: "pi" });
    const bytes = Buffer.from([1, 2, 3, 4]);
    const legacy = storeSessionAttachment("sess-attachments", { data: bytes, mimeType: "image/png" });
    // Identical bytes under a new ID are stored under that ID, not remapped to the existing one.
    const assigned = storeSessionAttachment("sess-attachments", { id: "att_node", data: bytes, mimeType: "image/png", width: 2, height: 2 });
    expect(assigned).toMatchObject({ id: "att_node", sha256: legacy.sha256, byteSize: 4, width: 2, height: 2 });
    expect(Buffer.from(getSessionAttachment("sess-attachments", legacy.id)!.data!)).toEqual(bytes);
    expect(Buffer.from(getSessionAttachment("sess-attachments", "att_node")!.data!)).toEqual(bytes);
    expect(storeSessionAttachment("sess-attachments", { id: "att_node", data: bytes, mimeType: "image/png" })).toEqual(assigned);
    expect(() => storeSessionAttachment("sess-attachments", { id: "att_node", data: Buffer.from([9]), mimeType: "image/png" }))
      .toThrow("Attachment att_node is already stored with different content");
    expect(() => storeSessionAttachment("sess-attachments", { id: "att_node", data: bytes, mimeType: "image/gif" }))
      .toThrow("Attachment att_node is already stored with different content");
    expect(() => storeSessionAttachment("sess-other", { id: "att_node", data: bytes, mimeType: "image/png" }))
      .toThrow("Attachment ID already in use: att_node");
    expect(getSessionAttachment("sess-other", "att_node")).toBeNull();
  });

  test("hydrates stored image refs back to runtime blocks", () => {
    const info = storeSessionAttachment("sess-attachments", { data: Buffer.from("hello"), mimeType: "image/png", filename: "shot.png", width: 320, height: 200 });
    const externalizedImage = { type: "image" as const, attachmentId: info.id, mimeType: info.mimeType, byteSize: info.byteSize, width: 320, height: 200 };
    expect(externalizedImage.attachmentId).toStartWith("att_");
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

});
