import { beforeEach, describe, expect, test } from "bun:test";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { createServerState } from "../helpers/server-state.js";
import { makeRequest } from "../helpers/request.js";
import { useTestDb } from "../helpers/test-db.js";

let projectId: number;

function writeUInt32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function pngBytes(width = 640, height = 480): Buffer {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  writeUInt32BE(bytes, 16, width);
  writeUInt32BE(bytes, 20, height);
  return Buffer.from(bytes);
}

function pngFile(bytes = pngBytes()): File {
  const body = new Uint8Array(bytes.length);
  body.set(bytes);
  return new File([body], "screen.png", { type: "image/png" });
}

describe("session attachment routes", () => {
  useTestDb();

  beforeEach(() => {
    const project = createProject("Attachment Routes", "/tmp/attachment-routes");
    projectId = project.id;
    createSession("sess-route", projectId, { agentRuntimeType: "pi" });
    createSession("sess-other", projectId, { agentRuntimeType: "pi" });
  });

  test("uploads and fetches image bytes scoped to the session", async () => {
    const router = buildRouter();
    const state = createServerState();
    const bytes = pngBytes(640, 480);
    const form = new FormData();
    form.append("files", pngFile(bytes));

    const upload = await router.handle(
      makeRequest("/api/sessions/sess-route/attachments", { method: "POST", body: form }),
      state,
    );
    expect(upload?.status).toBe(200);
    const body = await upload!.json();
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      filename: "screen.png",
      byteSize: bytes.length,
      width: 640,
      height: 480,
    });
    expect(body.attachments[0].url).toBe(`/api/sessions/sess-route/attachments/${body.attachments[0].id}`);

    const fetched = await router.handle(
      makeRequest(`/api/sessions/sess-route/attachments/${body.attachments[0].id}`),
      state,
    );
    expect(fetched?.status).toBe(200);
    expect(fetched?.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await fetched!.arrayBuffer()).toString("hex")).toBe(bytes.toString("hex"));

    const wrongSession = await router.handle(
      makeRequest(`/api/sessions/sess-other/attachments/${body.attachments[0].id}`),
      state,
    );
    expect(wrongSession?.status).toBe(404);
  });

  test("rejects non-image uploads", async () => {
    const router = buildRouter();
    const state = createServerState();
    const form = new FormData();
    form.append("files", new File(["hello"], "note.txt", { type: "text/plain" }));

    const upload = await router.handle(
      makeRequest("/api/sessions/sess-route/attachments", { method: "POST", body: form }),
      state,
    );

    expect(upload?.status).toBe(400);
  });

  test("does not read upload bytes before validating the session", async () => {
    const router = buildRouter();
    const state = createServerState();
    const form = new FormData();
    const file = pngFile();
    Object.defineProperty(file, "arrayBuffer", {
      value: () => { throw new Error("Upload bytes should not be read"); },
    });
    form.append("files", file);

    const upload = await router.handle(
      makeRequest("/api/sessions/missing-session/attachments", { method: "POST", body: form }),
      state,
    );

    expect(upload?.status).toBe(404);
  });

  test("rejects malformed image bytes", async () => {
    const router = buildRouter();
    const state = createServerState();
    const form = new FormData();
    form.append("files", pngFile(Buffer.from([137, 80, 78, 71])));

    const upload = await router.handle(
      makeRequest("/api/sessions/sess-route/attachments", { method: "POST", body: form }),
      state,
    );

    expect(upload?.status).toBe(400);
  });
});
