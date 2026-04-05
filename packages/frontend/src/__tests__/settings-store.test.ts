/**
 * Tests for SettingsStore — settings panel data fetching and mutations.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SettingsStore } from "../models/stores/settings-store.js";
import { mockFetch, restoreFetch } from "./helpers/mock-fetch.js";

function jsonResponse(data: unknown, ok = true): Response {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SettingsStore", () => {
  let store: SettingsStore;

  beforeEach(() => {
    store = new SettingsStore();
    restoreFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  test("load populates state from the settings endpoints", async () => {
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
      if (url === "/api/settings/default_model") {
        return jsonResponse({
          value: {
            provider: "anthropic",
            modelId: "claude-sonnet-4",
            thinkingLevel: "medium",
          },
        });
      }
      if (url === "/api/oauth/providers") {
        return jsonResponse([
          { id: "openrouter", name: "OpenRouter", configured: false },
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
    expect(store.defaultModel).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "medium",
    });
    expect(store.selectedProvider).toBe("anthropic");
    expect(store.selectedModel).toBe("claude-sonnet-4");
    expect(store.selectedThinking).toBe("medium");
    expect(store.availableOAuthProviders.map((provider) => provider.id)).toEqual(["openrouter"]);
  });

  test("saveApiKey persists the key and reloads provider state", async () => {
    let saved = false;
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    mockFetch((url, init) => {
      requests.push({ url, init });
      if (url === "/api/settings/api_key_openai" && init?.method === "PUT") {
        saved = true;
        return new Response(null, { status: 200 });
      }
      if (url === "/api/models") {
        return jsonResponse([
          {
            provider: "openai",
            hasKey: saved,
            keySource: saved ? "db" : null,
            keySources: saved ? ["db"] : [],
            models: [{ id: "gpt-4.1", name: "GPT-4.1", reasoning: false }],
          },
        ]);
      }
      if (url === "/api/settings/default_model") {
        return new Response(null, { status: 404 });
      }
      if (url === "/api/oauth/providers") {
        return jsonResponse([]);
      }
      return jsonResponse({}, false);
    });

    const result = await store.saveApiKey("openai", "sk-live");

    expect(result).toEqual({ ok: true });
    expect(store.apiKeySaving).toBe(false);
    expect(store.apiKeys).toEqual([
      {
        provider: "openai",
        label: "Openai",
        keySource: "db",
        keySources: ["db"],
      },
    ]);
    const saveRequest = requests.find((request) => request.url === "/api/settings/api_key_openai");
    expect(saveRequest?.init?.method).toBe("PUT");
    expect(saveRequest?.init?.body).toBe(JSON.stringify("sk-live"));
  });

  test("startOAuthLogin stores the auth URL and instructions", async () => {
    mockFetch((url, init) => {
      if (url === "/api/oauth/start/openrouter" && init?.method === "POST") {
        return jsonResponse({
          url: "https://example.com/oauth/start",
          instructions: "Paste the callback URL after login.",
        });
      }
      return jsonResponse({}, false);
    });

    const result = await store.startOAuthLogin("openrouter");

    expect(result).toEqual({ ok: true });
    expect(store.oauthLoading).toBe(false);
    expect(store.oauthLoginProvider).toBe("openrouter");
    expect(store.oauthAuthUrl).toBe("https://example.com/oauth/start");
    expect(store.oauthInstructions).toBe("Paste the callback URL after login.");
  });

  test("selectProvider chooses the first model and persists the default model", async () => {
    store.providers = [
      {
        provider: "anthropic",
        hasKey: true,
        keySource: "db",
        keySources: ["db"],
        models: [
          { id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true },
          { id: "claude-opus-4", name: "Claude Opus 4", reasoning: true },
        ],
      },
    ];

    let persistedBody: string | undefined;
    mockFetch((url, init) => {
      if (url === "/api/settings/default_model" && init?.method === "PUT") {
        persistedBody = String(init.body);
        return new Response(null, { status: 200 });
      }
      return jsonResponse({}, false);
    });

    const result = await store.selectProvider("anthropic");

    expect(result).toEqual({ ok: true });
    expect(store.selectedProvider).toBe("anthropic");
    expect(store.selectedModel).toBe("claude-sonnet-4");
    expect(store.selectedThinking).toBe("high");
    expect(store.defaultModel).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "high",
    });
    expect(persistedBody).toBe(JSON.stringify({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "high",
    }));
  });

  test("selectDefaultModel persists a chosen provider/model pair in one request", async () => {
    store.providers = [
      {
        provider: "anthropic",
        hasKey: true,
        keySource: "db",
        keySources: ["db"],
        models: [
          { id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true },
          { id: "claude-opus-4", name: "Claude Opus 4", reasoning: true },
        ],
      },
      {
        provider: "openai",
        hasKey: true,
        keySource: "db",
        keySources: ["db"],
        models: [{ id: "gpt-4.1", name: "GPT-4.1", reasoning: false }],
      },
    ];
    store.selectedThinking = "medium";

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch((url, init) => {
      requests.push({ url, init });
      if (url === "/api/settings/default_model" && init?.method === "PUT") {
        return new Response(null, { status: 200 });
      }
      return jsonResponse({}, false);
    });

    const result = await store.selectDefaultModel("openai", "gpt-4.1");

    expect(result).toEqual({ ok: true });
    expect(store.selectedProvider).toBe("openai");
    expect(store.selectedModel).toBe("gpt-4.1");
    expect(store.selectedThinking).toBe("high");
    expect(store.defaultModel).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
      thinkingLevel: "high",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.body).toBe(JSON.stringify({
      provider: "openai",
      modelId: "gpt-4.1",
      thinkingLevel: "high",
    }));
  });

  test("clearDefaultModel removes the saved selection and resets local fields", async () => {
    store.defaultModel = {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "medium",
    };
    store.selectedProvider = "anthropic";
    store.selectedModel = "claude-sonnet-4";
    store.selectedThinking = "medium";

    mockFetch((url, init) => {
      if (url === "/api/settings/default_model" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({}, false);
    });

    const result = await store.clearDefaultModel();

    expect(result).toEqual({ ok: true });
    expect(store.defaultModel).toBeNull();
    expect(store.selectedProvider).toBe("");
    expect(store.selectedModel).toBe("");
    expect(store.selectedThinking).toBe("high");
    expect(store.savingModel).toBe(false);
  });
});
