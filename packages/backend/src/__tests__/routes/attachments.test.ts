import { beforeEach, describe, expect, test } from "bun:test";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { createServerState } from "../helpers/server-state.js";
import { makeRequest } from "../helpers/request.js";
import { useTestDb } from "../helpers/test-db.js";

let projectId: number;

function pngFile(bytes = [137, 80, 78, 71]): File {
  return new File([new Uint8Array(bytes)], "screen.png", { type: "image/png" });
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
    const form = new FormData();
    form.append("files", pngFile());

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
      byteSize: 4,
    });
    expect(body.attachments[0].url).toBe(`/api/sessions/sess-route/attachments/${body.attachments[0].id}`);

    const fetched = await router.handle(
      makeRequest(`/api/sessions/sess-route/attachments/${body.attachments[0].id}`),
      state,
    );
    expect(fetched?.status).toBe(200);
    expect(fetched?.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await fetched!.arrayBuffer()).toString("hex")).toBe(Buffer.from([137, 80, 78, 71]).toString("hex"));

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
});
