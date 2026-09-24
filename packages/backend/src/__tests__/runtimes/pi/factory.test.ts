import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createPiContext, createPiModelRuntime, createPiResources } from "../../../runtimes/pi/factory.js";
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

  test("uses Reins discovery for Pi prompt context and executable skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "reins-pi-resources-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agents");
    const piAgentDir = join(root, "pi-agent");
    try {
      mkdirSync(join(cwd, ".agents", "skills", "project-skill"), { recursive: true });
      mkdirSync(join(agentDir, "skills", "global-skill"), { recursive: true });
      mkdirSync(join(piAgentDir, "skills", "pi-only"), { recursive: true });
      writeFileSync(join(agentDir, "AGENTS.md"), "Global instructions");
      writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
      writeFileSync(join(agentDir, "skills", "global-skill", "SKILL.md"), "---\nname: global-skill\ndescription: Global skill.\n---\n\nGlobal body\n");
      writeFileSync(join(cwd, ".agents", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\ndescription: Project skill.\n---\n\nProject body\n");
      writeFileSync(join(piAgentDir, "AGENTS.md"), "Pi-only instructions");
      writeFileSync(join(piAgentDir, "skills", "pi-only", "SKILL.md"), "---\nname: pi-only\ndescription: Pi-only skill.\n---\n\nPi-only body\n");
      const { resourceLoader, resources } = await createPiResources({ cwd, reinsAgentDir: agentDir, piAgentDir });

      expect(resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.content)).toEqual([
        "Global instructions", "Project instructions",
      ]);
      expect(resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(resources.skills.map((skill) => skill.name));
      expect(resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["global-skill", "project-skill"]);
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
