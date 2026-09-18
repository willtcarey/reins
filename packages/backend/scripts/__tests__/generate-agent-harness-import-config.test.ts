import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateImportConfig } from "../generate-agent-harness-import-config.js";

describe("generate AgentHarness import config", () => {
  test("normalizes only approved Claude provider aliases and preserves model IDs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-import-config-"));
    const path = join(dir, "source.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE sessions (id TEXT, model_provider TEXT, model_id TEXT)");
    db.query("INSERT INTO sessions VALUES (?, ?, ?)").run("claude", "claude_agent_sdk", "claude-sonnet-retired");
    db.query("INSERT INTO sessions VALUES (?, ?, ?)").run("pi", "openai-codex", "gpt-exact");
    db.close();
    try {
      const config = generateImportConfig(path, [
        { provider: "openai-codex", modelId: "gpt-exact" },
        { provider: "anthropic", modelId: "claude-current" },
      ]);
      expect(config.sessions).toEqual({
        claude: { model: { provider: "anthropic", modelId: "claude-sonnet-retired" } },
        pi: { model: { provider: "openai-codex", modelId: "gpt-exact" } },
      });
      expect(config.catalog).toEqual([
        { provider: "anthropic", modelId: "claude-current" },
        { provider: "openai-codex", modelId: "gpt-exact" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects sessions without explicit model identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-import-config-"));
    const path = join(dir, "source.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE sessions (id TEXT, model_provider TEXT, model_id TEXT); INSERT INTO sessions VALUES ('missing', NULL, NULL)");
    db.close();
    try {
      expect(() => generateImportConfig(path, [])).toThrow("Session missing has no explicit model identity");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
