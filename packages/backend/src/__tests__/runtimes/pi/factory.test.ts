import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createPiModelRuntime, createPiUtilityContext } from "../../../runtimes/pi/factory.js";
import { setApiKeyCredential } from "../../../auth-credentials-store.js";
import { useTestDb } from "../../helpers/test-db.js";

describe("pi runtime", () => {
  useTestDb();
  test("builds a model runtime with built-in providers", async () => {
    const modelRuntime = await createPiModelRuntime();

    expect(modelRuntime.getModels().length).toBeGreaterThan(0);
    expect(modelRuntime.getModel("anthropic", "claude-sonnet-4-5")).toBeDefined();
  });

  test("utility asks carry only their system prompt: no skills or context files from the server's directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "reins-pi-utility-"));
    try {
      mkdirSync(join(root, ".agents", "skills", "project-skill"), { recursive: true });
      writeFileSync(join(root, "AGENTS.md"), "Project instructions");
      writeFileSync(join(root, ".agents", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\ndescription: Project skill.\n---\n\nBody\n");
      const { resourceLoader, modelRuntime } = await createPiUtilityContext({ cwd: root, systemPrompt: "Parse tasks." });

      expect(resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
      expect(resourceLoader.getSkills().skills).toEqual([]);
      expect(resourceLoader.getSystemPrompt()).toBe("Parse tasks.");
      expect(modelRuntime.getModel("anthropic", "claude-sonnet-4-5")).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
