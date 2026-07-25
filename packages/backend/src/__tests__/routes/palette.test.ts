import { describe, expect, test } from "bun:test";
import { API } from "../../api-paths.js";
import { persistMessages } from "../../messages-store.js";
import { createProject } from "../../project-store.js";
import { buildRouter } from "../../routes/index.js";
import { createSession } from "../../session-store.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestDb } from "../helpers/test-db.js";

describe("palette routes", () => {
  useTestDb();

  test("GET /api/palette returns session items", async () => {
    const project = createProject("Test Project", "/tmp/test-project");
    createSession("session-1", project.id, { agentRuntimeType: "pi" });
    persistMessages("session-1", [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);

    const response = await buildRouter().handle(
      makeRequest(API.palette),
      createServerState(),
    );

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual([
      expect.objectContaining({ sessionId: "session-1" }),
    ]);
  });
});
