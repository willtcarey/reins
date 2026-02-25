import { describe, test, expect } from "bun:test";
import { buildRouter } from "../../routes/index.js";
import { createTestState } from "../helpers/test-state.js";

function makeRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("GET /api/health", () => {
  test("returns 200 with status ok", async () => {
    const router = buildRouter();
    const state = createTestState();
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
    sessions.set("s1", { session: { isStreaming: false }, id: "s1", lastActivity: Date.now() });
    sessions.set("s2", { session: { isStreaming: true }, id: "s2", lastActivity: Date.now() });
    const state = createTestState({ sessions });

    const res = await router.handle(makeRequest("GET", "/api/health"), state);
    const body = await res!.json();
    expect(body.activeSessions).toBe(2);
    expect(body.streaming).toBe(true);
  });
});
