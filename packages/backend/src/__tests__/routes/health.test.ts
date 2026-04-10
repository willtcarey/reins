import { describe, test, expect } from "bun:test";
import { buildRouter } from "../../routes/index.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { createTestManagedSession } from "../helpers/test-pi.js";

describe("GET /api/health", () => {
  test("returns 200 with status ok", async () => {
    const router = buildRouter();
    const state = createServerState();
    const res = await router.handle(makeRequest("GET", "/api/health"), state);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.status).toBe("ok");
    expect(body.activeSessions).toBe(0);
    expect(body.streaming).toBe(false);
  });

  test("reports active session count", async () => {
    const router = buildRouter();
    const sessions = new Map();
    sessions.set("s1", await createTestManagedSession("s1", { isStreaming: false }));
    sessions.set("s2", await createTestManagedSession("s2", { isStreaming: true }));
    const state = createServerState({ sessions });

    const res = await router.handle(makeRequest("GET", "/api/health"), state);
    const body = await res!.json();
    expect(body.activeSessions).toBe(2);
    expect(body.streaming).toBe(true);
  });
});
