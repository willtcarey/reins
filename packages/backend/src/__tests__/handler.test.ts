import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFetch } from "../handler.js";
import type { UpgradeServer } from "../state.js";
import { makeRequest } from "./helpers/request.js";
import { createAppState, type TestAppState } from "./helpers/app-state.js";
import { useTestDb } from "./helpers/test-db.js";

/** A server that upgrades nothing: these requests are plain HTTP. */
const server: UpgradeServer = { upgrade: () => false };

describe("handleFetch", () => {
  useTestDb();
  let frontendDir: string;
  let state: TestAppState;

  beforeEach(async () => {
    frontendDir = await mkdtemp(join(tmpdir(), "reins-handler-test-"));
    await Bun.write(join(frontendDir, "index.html"), "<html><body>spa</body></html>");
    state = createAppState({ frontendDir });
  });

  afterEach(async () => {
    state.process.nodes.close();
    await rm(frontendDir, { recursive: true, force: true });
  });

  test("answers an unknown API route with a JSON 404, not the web app", async () => {
    for (const [method, path] of [["GET", "/api/no-such-route"], ["POST", "/api/nodes/internal/no-such-action"], ["DELETE", "/api/health"], ["GET", "/api"]] as const) {
      const response = (await handleFetch(state, makeRequest(method, path), server))!;
      expect({ method, path, status: response.status, body: await response.json() })
        .toEqual({ method, path, status: 404, body: { error: `No API route ${method} ${path}` } });
    }
  });

  test("answers an unknown path under /nodes with a 404, not the web app", async () => {
    for (const path of ["/nodes", "/nodes/", "/nodes/installer", "/nodes/builds/abc", "/nodes/builds/abc/other.js"]) {
      const response = (await handleFetch(state, makeRequest(path), server))!;
      expect({ path, status: response.status, body: await response.text() }).toEqual({ path, status: 404, body: "Not found" });
    }
  });

  test("serves the web app for browser routes", async () => {
    for (const path of ["/", "/projects/1/tasks/2", "/apidocs"]) {
      const response = (await handleFetch(state, makeRequest("GET", path), server))!;
      expect({ path, status: response.status, body: await response.text() }).toEqual({ path, status: 200, body: "<html><body>spa</body></html>" });
    }
  });
});
