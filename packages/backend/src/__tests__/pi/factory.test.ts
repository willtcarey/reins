import { afterEach, describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createPiModelRuntime, setUpPiConfigDir } from "../../pi/factory.js";
import { DbCredentialStore } from "../../pi/credential-store.js";
import { createCredentialLocks } from "../../process-state.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { useTestDb } from "../helpers/test-db.js";

/** A `models.json` with one custom provider offering `modelId`. */
const customModels = (modelId: string) => JSON.stringify({
  providers: { custom: { baseUrl: "http://127.0.0.1:9", api: "openai-completions", apiKey: "none", models: [{ id: modelId }] } },
});

/** Runs `use` with Pi's own agent directory (`~/.pi/agent`) at a temporary one holding `models.json`. */
async function withPiAgentDir(modelsJson: string, use: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
  writeFileSync(join(agentDir, "models.json"), modelsJson);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await use(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

describe("pi runtime", () => {
  useTestDb();
  afterEach(() => setUpPiConfigDir(null));

  test("reads models.json from <data dir>/pi, not from Pi's own directory", async () => {
    await withPiAgentDir(customModels("shared"), async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "reins-data-"));
      setUpPiConfigDir(dataDir);
      expect(existsSync(join(dataDir, "pi", "models.json"))).toBe(false);
      expect((await createPiModelRuntime({ credentials: new DbCredentialStore(createCredentialLocks()) })).getModel("custom", "shared")).toBeUndefined();

      writeFileSync(join(dataDir, "pi", "models.json"), customModels("own"));
      expect((await createPiModelRuntime({ credentials: new DbCredentialStore(createCredentialLocks()) })).getModel("custom", "own")).toBeDefined();
    });
  });

  test("before a data directory is set up, reads no models.json, not even Pi's own", async () => {
    await withPiAgentDir(customModels("first"), async () => {
      const modelRuntime = await createPiModelRuntime({ credentials: new DbCredentialStore(createCredentialLocks()) });
      expect(modelRuntime.getModel("custom", "first")).toBeUndefined();
    });
  });
  test("builds a model runtime with built-in providers", async () => {
    const modelRuntime = await createPiModelRuntime({ credentials: new DbCredentialStore(createCredentialLocks()) });

    expect(modelRuntime.getModels().length).toBeGreaterThan(0);
    expect(modelRuntime.getModel("anthropic", "claude-sonnet-4-5")).toBeDefined();
  });

  test("refreshes remote model catalogs without Reins model declarations", async () => {
    setApiKeyCredential("anthropic", "sk-test");
    const baseline = getModel("anthropic", "claude-sonnet-4-5");
    if (!baseline) throw new Error("Expected Pi's Anthropic baseline model");

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname.endsWith("/anthropic")) {
          return Response.json([
            { ...baseline, id: "claude-future-dynamic", name: "Claude Future Dynamic" },
          ], {
            headers: { "last-modified": "Mon, 01 Jan 2100 00:00:00 GMT" },
          });
        }
        return new Response(null, { status: 404 });
      },
    });
    const previousOffline = process.env.PI_OFFLINE;
    delete process.env.PI_OFFLINE;

    try {
      const modelRuntime = await createPiModelRuntime({
        allowModelNetwork: true,
        catalogBaseUrl: server.url.toString(),
        modelsStore: new InMemoryModelsStore(),
        credentials: new DbCredentialStore(createCredentialLocks()),
      });

      expect(modelRuntime.getModel("anthropic", "claude-future-dynamic")?.name)
        .toBe("Claude Future Dynamic");

      // With a data directory, the fetched catalog is kept beside its models.json.
      const dataDir = mkdtempSync(join(tmpdir(), "reins-data-"));
      setUpPiConfigDir(dataDir);
      await createPiModelRuntime({ allowModelNetwork: true, catalogBaseUrl: server.url.toString(), credentials: new DbCredentialStore(createCredentialLocks()) });
      expect(readFileSync(join(dataDir, "pi", "models-store.json"), "utf8")).toContain("claude-future-dynamic");
    } finally {
      if (previousOffline !== undefined) process.env.PI_OFFLINE = previousOffline;
      await server.stop();
    }
  });
});
