import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFetch } from "../handler.js";
import type { ServerState } from "../state.js";
import { makeRequest } from "./helpers/request.js";
import { createServerState } from "./helpers/server-state.js";
import { useTestDb } from "./helpers/test-db.js";

describe("handleFetch", () => {
  useTestDb();
  let frontendDir: string;
  let state: ServerState;

  beforeEach(async () => {
    frontendDir = await mkdtemp(join(tmpdir(), "reins-handler-test-"));
    await Bun.write(join(frontendDir, "index.html"), "<html><body>spa</body></html>");
    state = createServerState({ frontendDir });
  });

  afterEach(async () => {
    state.nodes.close();
    await rm(frontendDir, { recursive: true, force: true });
  });

  test("answers an unknown API route with a JSON 404, not the web app", async () => {
    for (const [method, path] of [["GET", "/api/no-such-route"], ["POST", "/api/nodes/internal/no-such-action"], ["DELETE", "/api/health"], ["GET", "/api"]] as const) {
      const response = (await handleFetch(state, makeRequest(method, path), null))!;
      expect({ method, path, status: response.status, body: await response.json() })
        .toEqual({ method, path, status: 404, body: { error: `No API route ${method} ${path}` } });
    }
  });

  test("serves the web app for browser routes", async () => {
    for (const path of ["/", "/projects/1/tasks/2", "/apidocs"]) {
      const response = (await handleFetch(state, makeRequest("GET", path), null))!;
      expect({ path, status: response.status, body: await response.text() }).toEqual({ path, status: 200, body: "<html><body>spa</body></html>" });
    }
  });
});
