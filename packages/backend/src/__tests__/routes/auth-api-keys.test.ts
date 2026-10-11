import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { buildRouter } from "../../routes/index.js";
import { getAuthCredential, setApiKeyCredential } from "../../auth-credentials-store.js";

describe("auth api key routes", () => {
  useTestDb();

  const setup = () => {
    const state = createServerState();
    const router = buildRouter();
    return { state, router };
  };

  test("GET /api/auth/api-keys returns configured providers as redacted", async () => {
    const { router, state } = setup();
    setApiKeyCredential("anthropic", "sk-ant-test");

    const res = await router.handle(makeRequest("GET", "/api/auth/api-keys"), state);

    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual([
      {
        provider: "anthropic",
        configured: true,
      },
    ]);
  });

  test("GET /api/auth/api-keys/:provider reports configured state", async () => {
    const { router, state } = setup();
    setApiKeyCredential("anthropic", "sk-ant-test");

    const res = await router.handle(makeRequest("GET", "/api/auth/api-keys/anthropic"), state);

    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ provider: "anthropic", configured: true });
  });

  test("PUT /api/auth/api-keys/:provider stores an API key", async () => {
    const { router, state } = setup();

    const res = await router.handle(
      makeRequest("PUT", "/api/auth/api-keys/anthropic", { apiKey: "sk-ant-test" }),
      state,
    );

    expect(res!.status).toBe(200);
    expect(getAuthCredential("anthropic", "api_key")).toEqual({
      provider: "anthropic",
      type: "api_key",
      value: "sk-ant-test",
      updatedAt: expect.any(String),
    });
  });

  test("PUT /api/auth/api-keys/:provider validates body", async () => {
    const { router, state } = setup();

    const res = await router.handle(
      makeRequest("PUT", "/api/auth/api-keys/anthropic", { wrong: true }),
      state,
    );

    expect(res!.status).toBe(400);
    expect(await res!.json()).toEqual({
      error: "Invalid request body: apiKey: Expected required property",
    });
  });

  test("DELETE /api/auth/api-keys/:provider removes only the API key credential", async () => {
    const { router, state } = setup();
    setApiKeyCredential("anthropic", "sk-ant-test");

    const res = await router.handle(
      makeRequest("DELETE", "/api/auth/api-keys/anthropic"),
      state,
    );

    expect(res!.status).toBe(204);
    expect(getAuthCredential("anthropic", "api_key")).toBeNull();
  });
});
