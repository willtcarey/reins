import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { bindNodeSession, initializeNodeStorage, openNodeStorage } from "../storage.js";
import { createAgentHarnessPiRuntime } from "./pi-runtime.js";

test("node-owned Pi executes and reopens against node SQLite without product tables", async () => {
  const node = new Database(":memory:");
  initializeNodeStorage(node);
  const binding = { sourceId: 1, cwd: "/tmp/local-node-runtime", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  bindNodeSession(node, "node-pi", binding);
  const provider = fauxProvider({ models: [{ id: "fake", contextWindow: 20_000, maxTokens: 100 }] });
  provider.setResponses([fauxAssistantMessage("node result")]);
  const models = createModels();
  models.setProvider(provider.provider);
  try {
    const open = async () => createAgentHarnessPiRuntime({
      storage: await openNodeStorage(node, "node-pi", () => {}),
      sessionId: "node-pi", createdAt: Date.parse(binding.createdAt), cwd: binding.cwd,
      options: { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });
    const runtime = await open();
    await runtime.prompt([{ type: "text", text: "hello" }]);
    await runtime.waitForIdle();
    await runtime.close();
    const reopened = await open();
    expect((await reopened.getMessages()).map(message => message.role)).toEqual(["user", "assistant"]);
    await reopened.close();
  } finally { node.close(); }
});
