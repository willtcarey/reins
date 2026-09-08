import { describe, test, expect } from "bun:test";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createPiContext, createPiModelRuntime } from "../../../runtimes/pi/factory.js";
import { setApiKeyCredential } from "../../../auth-credentials-store.js";
import { useTestDb } from "../../helpers/test-db.js";

describe("pi runtime", () => {
  useTestDb();
  test("builds a cwd-scoped runtime with built-in providers", async () => {
    const runtime = await createPiContext({
      cwd: "/tmp/reins-pi-runtime",
    });

    expect(runtime.modelRuntime.getModels().length).toBeGreaterThan(0);
    expect(runtime.modelRuntime.getModel("anthropic", "claude-sonnet-4-5")).toBeDefined();
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
      });

      expect(modelRuntime.getModel("anthropic", "claude-future-dynamic")?.name)
        .toBe("Claude Future Dynamic");
    } finally {
      if (previousOffline !== undefined) process.env.PI_OFFLINE = previousOffline;
      await server.stop();
    }
  });
});
