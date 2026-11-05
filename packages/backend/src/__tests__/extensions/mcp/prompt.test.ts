import { describe, expect, test } from "bun:test";
import type { PromptContext } from "@reins/sdk/server";
import { SessionModel } from "../../../models/session.js";
import { createSession } from "../../../sessions/create-session.js";
import { getSource } from "../../../node-store.js";
import { getSession } from "../../../session-store.js";
import { createProject } from "../../project-fixture.js";
import { createAppState } from "../../helpers/app-state.js";
import { testMcp } from "../../helpers/mcp-extension.js";
import { useTestDb } from "../../helpers/test-db.js";
import { useTestRepo } from "../../helpers/test-repo.js";

const context = (tools: readonly string[] | null): PromptContext => ({ session: { id: "s", projectId: 1, taskId: null }, task: null, tools });

/** An app with the MCP extension, and its servers. */
function mcpState() {
  const mcp = testMcp();
  const state = createAppState(undefined, { extensions: [mcp.registration] });
  return { state, servers: mcp.servers };
}

describe("the MCP extension's prompt section", () => {
  useTestDb();
  const repo = useTestRepo();

  test("tells a session offered execute the enabled servers, their instructions and how to find and call their tools", async () => {
    const { state, servers } = mcpState();
    await servers.create({ name: "executor", instructions: "Integrations: github_com, sentry_io.\nFind their tools with search_<integration>.", url: "https://executor.example.com/mcp", authKind: "none" });
    await servers.create({ name: "vercel", url: "https://vercel.example.com/mcp", authKind: "none" });
    await servers.create({ name: "slack", url: "https://slack.example.com/mcp", authKind: "none", enabled: false });

    expect(await state.extensions.promptSections(context(null))).toEqual([`MCP servers (through execute): find their tools with api.tools.search(query), or api.tools.search(query, { filters: { server } }) for one server's; call one with api.tools.call(id, args). A tool's ID is mcp__<server>__<tool>. search does not list them.
- executor: Integrations: github_com, sentry_io.
  Find their tools with search_<integration>.
- vercel`]);
  });

  test("no enabled server, or no execute, means no section", async () => {
    const { state, servers } = mcpState();
    expect(await state.extensions.promptSections(context(null))).toEqual([]);

    await servers.create({ name: "vercel", url: "https://vercel.example.com/mcp", authKind: "none" });
    expect(await state.extensions.promptSections(context(["bash"]))).toEqual([]);
    expect(await state.extensions.promptSections(context(["execute"]))).toHaveLength(1);
  });

  test("reaches an agent session's prompt when its runtime opens", async () => {
    const { state, servers } = mcpState();
    const project = createProject("Reins", repo.dir);
    await servers.create({ name: "vercel", instructions: "vercel tools", url: "https://vercel.example.com/mcp", authKind: "none" });
    const created = createSession(state, { projectId: project.id, model: { provider: "anthropic", modelId: "claude-haiku-4-5" } });
    const row = getSession(created.id)!;

    const { systemPrompt } = (await new SessionModel(row, state.nodes).context(getSource(row.source_id)!, ctx => state.extensions.promptSections(ctx))).runtime;

    expect(systemPrompt).toContain("- vercel: vercel tools");
  });
});
