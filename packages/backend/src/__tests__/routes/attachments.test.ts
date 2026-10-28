import { beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../app-globals.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../project-fixture.js";
import { createSession } from "../session-fixture.js";
import { createAppState } from "../helpers/app-state.js";
import { noisePng } from "../helpers/noise-png.js";
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
    const state = createAppState();
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

  test("an image over the model provider's size limit is stored resized to 1568 px on its long side, under the limit", async () => {
    const router = buildRouter();
    const state = createAppState();
    const form = new FormData();
    form.append("files", pngFile(Buffer.from(noisePng(2000, 1500))));

    const upload = await router.handle(makeRequest("/api/sessions/sess-route/attachments", { method: "POST", body: form }), state);
    expect(upload?.status).toBe(200);
    const [attachment] = (await upload!.json()).attachments;
    expect(attachment).toMatchObject({ mimeType: "image/jpeg", filename: "screen.png", width: 1568, height: 1176 });

    const fetched = await router.handle(makeRequest(attachment.url), state);
    const stored = Buffer.from(await fetched!.arrayBuffer());
    expect(fetched?.headers.get("Content-Type")).toBe("image/jpeg");
    expect(stored.byteLength).toBe(attachment.byteSize);
    // Anthropic's limit on one image: 5 MB of base64.
    expect(stored.toString("base64").length).toBeLessThan(5_000_000);
  });

  test("rejects an image over the model provider's size limit that cannot be resized", async () => {
    const router = buildRouter();
    const state = createAppState();
    const undecodable = Buffer.concat([pngBytes(4000, 3000), Buffer.alloc(5 * 1024 * 1024, 1)]);
    const form = new FormData();
    form.append("files", pngFile(undecodable));

    const upload = await router.handle(makeRequest("/api/sessions/sess-route/attachments", { method: "POST", body: form }), state);

    expect(upload?.status).toBe(400);
    expect(await upload!.json()).toEqual({ error: "The image is 5.0 MiB, over the model provider's image size limit, and could not be resized" });
    expect(getDb().query("SELECT id FROM session_attachments WHERE session_id = 'sess-route'").all()).toEqual([]);
  });

  test("rejects non-image uploads", async () => {
    const router = buildRouter();
    const state = createAppState();
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
    const state = createAppState();
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
    expect(await upload!.json()).toEqual({ error: "Session not found" });
  });

  test("returns 404 when fetching an attachment for a missing session", async () => {
    const router = buildRouter();
    const state = createAppState();

    const fetched = await router.handle(
      makeRequest("/api/sessions/missing-session/attachments/missing-attachment"),
      state,
    );

    expect(fetched?.status).toBe(404);
    expect(await fetched!.json()).toEqual({ error: "Session not found" });
  });

  test("rejects malformed image bytes", async () => {
    const router = buildRouter();
    const state = createAppState();
    const form = new FormData();
    form.append("files", pngFile(Buffer.from([137, 80, 78, 71])));

    const upload = await router.handle(
      makeRequest("/api/sessions/sess-route/attachments", { method: "POST", body: form }),
      state,
    );

    expect(upload?.status).toBe(400);
  });
});
