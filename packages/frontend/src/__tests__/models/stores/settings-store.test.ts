/**
 * Tests for SettingsStore — settings values and settings-related mutations.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SettingsStore } from "../../../models/stores/settings-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

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
  });

  afterEach(() => {
    restoreFetch();
  });

  test("loadSettings populates settings and oauth state without fetching the model registry", async () => {
    const requests: string[] = [];

    mockFetch((url) => {
      requests.push(url);
      if (url === "/api/settings?key=default_model&key=utility_model&key=diff_renderer") {
        return jsonResponse([
          {
            key: "default_model",
            value: {
              provider: "anthropic",
              modelId: "claude-sonnet-4",
              runtimeType: "pi",
              thinkingLevel: "medium",
            },
            redacted: false,
          },
          {
            key: "utility_model",
            value: {
              provider: "anthropic",
              modelId: "claude-haiku-4-5",
              runtimeType: "pi",
              thinkingLevel: "minimal",
            },
            redacted: false,
          },
          {
            key: "diff_renderer",
            value: "virtual",
          },
        ]);
      }
      if (url === "/api/oauth/providers") {
        return jsonResponse([
          { id: "openrouter", name: "OpenRouter", configured: false },
        ]);
      }
      return jsonResponse({}, false);
    });

    const result = await store.loadSettings();

    expect(result).toEqual({ ok: true });
    expect(store.loading).toBe(false);
    expect(requests).not.toContain("/api/models");
    expect(store.getStoredModelSetting("default_model")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      runtimeType: "pi",
      thinkingLevel: "medium",
    });
    expect(store.getSelectedModelSetting("default_model")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      runtimeType: "pi",
      thinkingLevel: "medium",
    });
    expect(store.getStoredModelSetting("utility_model")).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      runtimeType: "pi",
      thinkingLevel: "minimal",
    });
    expect(store.getSelectedModelSetting("utility_model")).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      runtimeType: "pi",
      thinkingLevel: "minimal",
    });
    expect(store.diffRenderer).toBe("virtual");
    expect(store.oauthProviders.map((provider) => provider.id)).toEqual(["openrouter"]);
  });

  test("loadSettings defaults diffRenderer to classic when unset", async () => {
    mockFetch((url) => {
      if (url === "/api/settings?key=default_model&key=utility_model&key=diff_renderer") {
        return jsonResponse([]);
      }
      if (url === "/api/oauth/providers") {
        return jsonResponse([]);
      }
      return jsonResponse({}, false);
    });

    const result = await store.loadSettings();

    expect(result).toEqual({ ok: true });
    expect(store.diffRenderer).toBe("classic");
  });

  test("selectDiffRenderer persists the renderer setting and notifies setting-change listeners", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const changes: unknown[] = [];
    store.subscribeSettingChanges((change) => changes.push(change));

    mockFetch((url, init) => {
      requests.push({ url, init });
      if (url === "/api/settings/diff_renderer" && init?.method === "PUT") {
        return new Response(null, { status: 200 });
      }
      return jsonResponse({}, false);
    });

    const result = await store.selectDiffRenderer("virtual");

    expect(result).toEqual({ ok: true });
    expect(store.diffRenderer).toBe("virtual");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.body).toBe(JSON.stringify("virtual"));
    expect(changes).toEqual([{ key: "diff_renderer" }]);
  });

  test("loadSettings can request a subset of setting keys", async () => {
    const requests: string[] = [];

    mockFetch((url) => {
      requests.push(url);
      if (url === "/api/settings?key=default_model") {
        return jsonResponse([]);
      }
      if (url === "/api/oauth/providers") {
        return jsonResponse([]);
      }
      return jsonResponse({}, false);
    });

    const result = await store.loadSettings(["default_model"]);

    expect(result).toEqual({ ok: true });
    expect(requests).toContain("/api/settings?key=default_model");
  });


  test("saveApiKey persists the key via auth API endpoints without reloading /api/models", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const changes: unknown[] = [];
    store.subscribeSettingChanges((change) => changes.push(change));

    mockFetch((url, init) => {
      requests.push({ url, init });
      if (url === "/api/auth/api-keys/openai" && init?.method === "PUT") {
        return new Response(null, { status: 200 });
      }
      return jsonResponse({}, false);
    });

    const result = await store.saveApiKey("openai", "sk-live");

    expect(result).toEqual({ ok: true });
    expect(store.apiKeySaving).toBe(false);
    expect(requests.map((request) => request.url)).not.toContain("/api/models");
    const saveRequest = requests.find((request) => request.url === "/api/auth/api-keys/openai");
    expect(saveRequest?.init?.method).toBe("PUT");
    expect(saveRequest?.init?.body).toBe(JSON.stringify({ apiKey: "sk-live" }));
    expect(changes).toEqual([{ key: "api_key_openai" }]);
  });

  test("deleteApiKey removes the key via auth API endpoints without reloading /api/models", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const changes: unknown[] = [];
    store.subscribeSettingChanges((change) => changes.push(change));

    mockFetch((url, init) => {
      requests.push({ url, init });
      if (url === "/api/auth/api-keys/openai" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({}, false);
    });

    const result = await store.deleteApiKey("openai");

    expect(result).toEqual({ ok: true });
    expect(store.apiKeySaving).toBe(false);
    expect(requests.map((request) => request.url)).not.toContain("/api/models");
    const deleteRequest = requests.find((request) => request.url === "/api/auth/api-keys/openai");
    expect(deleteRequest?.init?.method).toBe("DELETE");
    expect(changes).toEqual([{ key: "api_key_openai" }]);
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

  test("selectModelSetting persists a chosen provider/model pair in one request", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const changes: unknown[] = [];
    store.subscribeSettingChanges((change) => changes.push(change));
    mockFetch((url, init) => {
      requests.push({ url, init });
      if (url === "/api/settings/default_model" && init?.method === "PUT") {
        return new Response(null, { status: 200 });
      }
      return jsonResponse({}, false);
    });

    await store.selectModelSetting("default_model", "anthropic", "claude-sonnet-4", "pi");
    await store.selectModelSettingThinkingLevel("default_model", "medium");
    requests.length = 0;
    changes.length = 0;

    const result = await store.selectModelSetting("default_model", "openai", "gpt-4.1", "pi");

    expect(result).toEqual({ ok: true });
    expect(store.getSelectedModelSetting("default_model")).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
      runtimeType: "pi",
      thinkingLevel: "high",
    });
    expect(store.getStoredModelSetting("default_model")).toEqual({
      provider: "openai",
      modelId: "gpt-4.1",
      runtimeType: "pi",
      thinkingLevel: "high",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.body).toBe(JSON.stringify({
      provider: "openai",
      modelId: "gpt-4.1",
      runtimeType: "pi",
      thinkingLevel: "high",
    }));
    expect(changes).toEqual([{ key: "default_model" }]);
  });

  test("selectModelSetting persists utility-model selections in one request", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch((url, init) => {
      requests.push({ url, init });
      if (url === "/api/settings/utility_model" && init?.method === "PUT") {
        return new Response(null, { status: 200 });
      }
      return jsonResponse({}, false);
    });

    const result = await store.selectModelSetting("utility_model", "anthropic", "claude-haiku-4-5", "pi");

    expect(result).toEqual({ ok: true });
    expect(store.getSelectedModelSetting("utility_model")).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      runtimeType: "pi",
      thinkingLevel: "minimal",
    });
    expect(store.getStoredModelSetting("utility_model")).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      runtimeType: "pi",
      thinkingLevel: "minimal",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.body).toBe(JSON.stringify({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      runtimeType: "pi",
      thinkingLevel: "minimal",
    }));
  });

  test("clearModelSetting removes the saved selection and resets local fields", async () => {
    const changes: unknown[] = [];
    store.subscribeSettingChanges((change) => changes.push(change));

    mockFetch((url, init) => {
      if (url === "/api/settings/default_model" && init?.method === "PUT") {
        return new Response(null, { status: 200 });
      }
      if (url === "/api/settings/default_model" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({}, false);
    });

    await store.selectModelSetting("default_model", "anthropic", "claude-sonnet-4", "pi");
    await store.selectModelSettingThinkingLevel("default_model", "medium");
    changes.length = 0;

    const result = await store.clearModelSetting("default_model");

    expect(result).toEqual({ ok: true });
    expect(store.getStoredModelSetting("default_model")).toBeNull();
    expect(store.getSelectedModelSetting("default_model")).toEqual({
      provider: "",
      modelId: "",
      runtimeType: "",
      thinkingLevel: "high",
    });
    expect(store.savingModel).toBe(false);
    expect(changes).toEqual([{ key: "default_model" }]);
  });
});
