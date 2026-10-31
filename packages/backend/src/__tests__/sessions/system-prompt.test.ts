import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { reinsSystemPrompt } from "../../sessions/system-prompt.js";
import { SessionModel } from "../../models/session.js";
import { insertMcpServer, type McpServerFields } from "../../mcp-server-store.js";
import { createSession } from "../../sessions/create-session.js";
import { getSource } from "../../node-store.js";
import { getSession } from "../../session-store.js";
import { createProject } from "../project-fixture.js";
import { createAppState } from "../helpers/app-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";

// Fixtures pin the server's sections as they were cut from the prompt the node used to render whole.
const expected = (name: string) => readFileSync(new URL(`../fixtures/system-prompt/${name}.txt`, import.meta.url), "utf8");

describe("reinsSystemPrompt", () => {
  test("a task session is told its task", () => {
    expect(reinsSystemPrompt({ task: { title: "Fix login bug", description: "Users can't log in" } })).toBe(expected("task"));
  });

  test("a scratch session is a project assistant session", () => {
    expect(reinsSystemPrompt({ task: null })).toBe(expected("scratch"));
  });

  test("session orchestration is described only when the session is offered execute", () => {
    expect(reinsSystemPrompt({ task: { title: "T", description: null }, tools: ["read", "write", "edit", "bash"] })).toBe(expected("task-no-description-no-execute"));
    expect(reinsSystemPrompt({ task: null, tools: ["execute"] })).toContain("Session orchestration (through execute)");
  });
});

describe("extensions' sections in the prompt", () => {
  test("follow the Reins section, its task included, in order", () => {
    const prompt = reinsSystemPrompt({ task: { title: "T", description: null }, sections: ["Section A", "Section B"] });

    expect(prompt).toBe(`${reinsSystemPrompt({ task: { title: "T", description: null } })}\n\nSection A\n\nSection B`);
  });
});

describe("MCP servers in the prompt", () => {
  test("a session offered execute is told the servers, their instructions and how to find their tools", () => {
    const prompt = reinsSystemPrompt({
      task: null,
      mcpServers: [
        { name: "executor", instructions: "Integrations: github_com, sentry_io.\nFind their tools with search_<integration>." },
        { name: "vercel", instructions: "" },
      ],
    });

    expect(prompt).toContain(`MCP servers (through execute): find a server's tools with api.mcp.tools(server, query), call one with api.mcp.call(server, tool, args). search does not list them.
- executor: Integrations: github_com, sentry_io.
  Find their tools with search_<integration>.
- vercel`);
  });

  test("no servers, or no execute, means no MCP section", () => {
    expect(reinsSystemPrompt({ task: null, mcpServers: [] })).not.toContain("MCP servers");
    expect(reinsSystemPrompt({ task: null, tools: ["bash"], mcpServers: [{ name: "vercel", instructions: "" }] })).not.toContain("MCP servers");
  });
});

const server = (name: string, enabled: boolean): McpServerFields => ({
  name, instructions: `${name} tools`, url: `https://${name}.example.com/mcp`, transport: "http", authKind: "none",
  headerName: null, oauthClientId: null, oauthScope: null, enabled,
});

describe("the agent kind", () => {
  useTestDb();
  const repo = useTestRepo();

  test("asks the app's extensions for their sections, with the session, its task and every tool", async () => {
    const project = createProject("Reins", repo.dir);
    const created = createSession(createAppState(), project.id, { model: { provider: "anthropic", modelId: "claude-haiku-4-5" } });
    const row = getSession(created.id)!;
    const asked: unknown[] = [];

    const { systemPrompt } = (await new SessionModel(row).context(getSource(row.source_id)!, async context => { asked.push(context); return ["From an extension"]; })).runtime;

    expect(systemPrompt).toEndWith("\n\nFrom an extension");
    expect(asked).toEqual([{ session: { id: row.id, projectId: project.id, taskId: null }, task: null, tools: null }]);
  });

  test("names the enabled MCP servers when the session's runtime opens", async () => {
    const project = createProject("Reins", repo.dir);
    insertMcpServer(server("vercel", true));
    insertMcpServer(server("slack", false));
    const created = createSession(createAppState(), project.id, { model: { provider: "anthropic", modelId: "claude-haiku-4-5" } });
    const row = getSession(created.id)!;

    const { systemPrompt } = (await new SessionModel(row).context(getSource(row.source_id)!)).runtime;

    expect(systemPrompt).toContain("- vercel: vercel tools");
    expect(systemPrompt).not.toContain("slack");
  });
});
