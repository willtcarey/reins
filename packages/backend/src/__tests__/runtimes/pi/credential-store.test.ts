import { describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { useTestDb } from "../../helpers/test-db.js";
import {
  DbCredentialStore,
  createDbCredentialStore,
} from "../../../runtimes/pi/credential-store.js";
import {
  getAuthCredential,
  setApiKeyCredential,
  setOAuthCredential,
} from "../../../auth-credentials-store.js";

describe("Pi database credential storage", () => {
  useTestDb();

  test("reads preferred API-key and OAuth credentials", async () => {
    setApiKeyCredential("anthropic", "sk-ant-db");
    setOAuthCredential("openai-codex", {
      refresh: "refresh-openai",
      access: "access-openai",
      expires: Date.now() + 60_000,
    });

    const store = new DbCredentialStore();

    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "sk-ant-db" });
    await expect(store.read("openai-codex")).resolves.toEqual({
      type: "oauth",
      refresh: "refresh-openai",
      access: "access-openai",
      expires: expect.any(Number),
    });
    await expect(store.list()).resolves.toEqual([
      { providerId: "anthropic", type: "api_key" },
      { providerId: "openai-codex", type: "oauth" },
    ]);
  });

  test("persists Pi credential modifications and deletion", async () => {
    const first = createDbCredentialStore();
    await first.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-fresh" }));

    expect(getAuthCredential("anthropic", "api_key")).toEqual({
      provider: "anthropic",
      type: "api_key",
      value: "sk-ant-fresh",
      updatedAt: expect.any(String),
    });

    const second = createDbCredentialStore();
    await expect(second.read("anthropic")).resolves.toEqual({ type: "api_key", key: "sk-ant-fresh" });

    await first.delete("anthropic");
    await expect(second.read("anthropic")).resolves.toBeUndefined();
  });

  test("keeps environment fallback in the model runtime", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";

    try {
      const modelRuntime = await ModelRuntime.create({
        credentials: createDbCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      expect((await modelRuntime.getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-env");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

});
