import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ModelRegistryStore } from "../models/stores/model-registry-store.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";

function jsonResponse(data: unknown, ok = true): Response {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ModelRegistryStore", () => {
  let store: ModelRegistryStore;

  beforeEach(() => {
    store = new ModelRegistryStore();
    restoreFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  test("load populates provider and model registry state from /api/models", async () => {
    mockFetch((url) => {
      if (url === "/api/models") {
        return jsonResponse([
          {
            provider: "anthropic",
            hasKey: true,
            keySource: "env",
            keySources: ["env"],
            models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true }],
          },
          {
            provider: "openai",
            hasKey: false,
            keySource: null,
            keySources: [],
            models: [{ id: "gpt-4.1", name: "GPT-4.1", reasoning: false }],
          },
        ]);
      }
      return jsonResponse({}, false);
    });

    const result = await store.load();

    expect(result).toEqual({ ok: true });
    expect(store.loading).toBe(false);
    expect(store.apiKeys).toEqual([
      {
        provider: "anthropic",
        label: "Anthropic",
        keySource: "env",
        keySources: ["env"],
      },
    ]);
    expect(store.unconfiguredProviders.map((provider) => provider.provider)).toEqual(["openai"]);
    expect(store.availableProviders.map((provider) => provider.provider)).toEqual(["anthropic"]);
    expect(store.getModelsForProvider("anthropic")).toEqual([
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true },
    ]);
    expect(store.findModel("anthropic", "claude-sonnet-4")?.name).toBe("Claude Sonnet 4");
  });
});
