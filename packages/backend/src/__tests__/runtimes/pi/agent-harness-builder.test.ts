import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { setApiKeyCredential } from "../../../auth-credentials-store.js";
import { createProject } from "../../../project-store.js";
import { createSession } from "../../../session-store.js";
import { buildAgentHarnessPiRuntime } from "../../../runtimes/pi/agent-harness-builder.js";
import { registerPiProvider, unregisterPiProvider } from "../../../runtimes/pi/factory.js";
import { createServerState } from "../../helpers/server-state.js";
import { useTestDb } from "../../helpers/test-db.js";

describe("unselected AgentHarness Pi builder", () => {
  useTestDb();

  test("assembles DB auth, Reins prompt, resources, and filtered builtin/custom tools", async () => {
    await mkdir("/tmp/harness-builder/.pi/skills/local", { recursive: true });
    await writeFile("/tmp/harness-builder/AGENTS.md", "UNIQUE_AGENTS_MARKER");
    await writeFile("/tmp/harness-builder/input.txt", "builder input");
    await writeFile("/tmp/harness-builder/.pi/skills/local/SKILL.md", "---\nname: local-builder\ndescription: Local builder skill\n---\nUNIQUE_SKILL_MARKER");
    const project = createProject("Builder", "/tmp/harness-builder");
    createSession("harness-builder", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({ provider: "builder-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
    const requests: { systemPrompt?: string; tools?: { name: string }[] }[] = [];
    const credentials: unknown[] = [];
    const apiKeyAuth = provider.provider.auth.apiKey;
    const baseResolve = apiKeyAuth?.resolve;
    if (!apiKeyAuth || !baseResolve) throw new Error("Expected faux API-key auth");
    const instrumentedProvider = {
      ...provider.provider,
      auth: { apiKey: { ...apiKeyAuth, resolve: async (input: Parameters<typeof baseResolve>[0]) => {
        credentials.push(input.credential);
        return baseResolve(input);
      } } },
    };
    provider.setResponses([
      (context) => {
        requests.push(structuredClone(context));
        setApiKeyCredential("builder-faux", "refreshed-key");
        return fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }, { id: "read-1" }), { stopReason: "toolUse" });
      },
      (context) => { requests.push(structuredClone(context)); return fauxAssistantMessage(fauxToolCall("custom_effect", {}, { id: "custom-1" }), { stopReason: "toolUse" }); },
      (context) => { requests.push(structuredClone(context)); return fauxAssistantMessage("built"); },
    ]);
    registerPiProvider(instrumentedProvider);
    setApiKeyCredential("builder-faux", "fake-key");
    let customExecutions = 0;
    const customTool = {
      name: "custom_effect", label: "effect", description: "custom effect", parameters: Type.Object({}), replay: "never" as const,
      async execute() { customExecutions++; return { content: [{ type: "text" as const, text: "ok" }], details: undefined }; },
    };

    try {
      const runtime = await buildAgentHarnessPiRuntime({
        state: createServerState(), projectId: project.id, projectDir: "/tmp/harness-builder",
        sessionId: "harness-builder", task: null,
        model: { provider: "builder-faux", modelId: "fake" }, thinkingLevel: "minimal",
        sessionTools: { builtins: ["read"], harnessTools: [customTool] }, resume: false,
      });
      await runtime.prompt([{ type: "text", text: "build" }]);
      await runtime.waitForIdle();

      const prompt = requests[0]!.systemPrompt ?? "";
      expect(prompt).toContain("You are REINS");
      expect(prompt.match(/UNIQUE_AGENTS_MARKER/g)).toHaveLength(1);
      expect(prompt.match(/local-builder/g)).toHaveLength(1);
      expect(prompt).not.toContain("UNIQUE_SKILL_MARKER");
      expect(requests[0]!.tools?.map((tool) => tool.name)).toEqual(["read", "custom_effect"]);
      expect(JSON.stringify(requests)).toContain("builder input");
      expect(customExecutions).toBe(1);
      expect(credentials).toHaveLength(5);
      expect(credentials).toContainEqual({ type: "api_key", key: "fake-key" });
      expect(credentials).toContainEqual({ type: "api_key", key: "refreshed-key" });
      expect(credentials.at(-1)).toEqual({ type: "api_key", key: "refreshed-key" });
      expect(runtime.getSessionMetadata()).toEqual({ model: { provider: "builder-faux", modelId: "fake" }, thinkingLevel: "minimal" });

      const skillAdmission = await runtime.lane.accept({ kind: "skill", name: "local-builder" }, BACKGROUND_CONTEXT);
      expect(skillAdmission.ok).toBe(true);
      const entries = await runtime.lane.findEntries(undefined, BACKGROUND_CONTEXT);
      expect(JSON.stringify(entries).match(/UNIQUE_SKILL_MARKER/g)).toHaveLength(1);

      expect(runtime.executionEnv).toBeInstanceOf(NodeExecutionEnv);
      let cleanups = 0;
      Object.defineProperty(runtime.executionEnv, "cleanup", { value: async () => { cleanups++; } });
      await runtime.close();
      await runtime.close();
      expect(cleanups).toBe(1);
    } finally {
      unregisterPiProvider("builder-faux");
    }
  });

  test("bash reads dynamic lane model and thinking environment without a session file", async () => {
    await mkdir("/tmp/harness-bash", { recursive: true });
    const project = createProject("Builder Bash", "/tmp/harness-bash");
    createSession("harness-bash", project.id, { agentRuntimeType: "pi" });
    const provider = fauxProvider({
      provider: "bash-faux",
      models: [
        { id: "one", contextWindow: 20_000, maxTokens: 1_000 },
        { id: "two", contextWindow: 20_000, maxTokens: 1_000 },
      ],
    });
    const contexts: unknown[] = [];
    const command = "printf '%s|%s|%s|%s|%s|%s' \"$PWD\" \"$PI_SESSION_ID\" \"$PI_PROVIDER\" \"$PI_MODEL\" \"$PI_REASONING_LEVEL\" \"${PI_SESSION_FILE-unset}\"";
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command }, { id: "bash-1" }), { stopReason: "toolUse" }),
      (context) => { contexts.push(structuredClone(context.messages)); return fauxAssistantMessage("first done"); },
      fauxAssistantMessage(fauxToolCall("bash", { command }, { id: "bash-2" }), { stopReason: "toolUse" }),
      (context) => { contexts.push(structuredClone(context.messages)); return fauxAssistantMessage("second done"); },
    ]);
    registerPiProvider(provider.provider);
    setApiKeyCredential("bash-faux", "fake-key");
    try {
      const runtime = await buildAgentHarnessPiRuntime({
        state: createServerState(), projectId: project.id, projectDir: "/tmp/harness-bash",
        sessionId: "harness-bash", task: null,
        model: { provider: "bash-faux", modelId: "one" }, thinkingLevel: "minimal",
        sessionTools: { builtins: ["bash"], harnessTools: [] }, resume: false,
      });
      await runtime.prompt([{ type: "text", text: "inspect environment" }]);
      await runtime.waitForIdle();
      await runtime.setModel({ provider: "bash-faux", modelId: "two", thinkingLevel: "high" });
      await runtime.prompt([{ type: "text", text: "inspect changed environment" }]);
      await runtime.waitForIdle();

      expect(JSON.stringify(contexts[0])).toContain("/tmp/harness-bash|harness-bash|bash-faux|one|minimal|unset");
      expect(JSON.stringify(contexts[1])).toContain("/tmp/harness-bash|harness-bash|bash-faux|two|high|unset");
      await runtime.close();
    } finally {
      unregisterPiProvider("bash-faux");
    }
  });
});
