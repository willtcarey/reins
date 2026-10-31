import { afterEach, describe, expect, test } from "bun:test";
import { runScript } from "../../../tools/execute.js";
import type { ApiContext } from "../../../scripting/define-function.js";
import { Models } from "../../../models/models.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { echoTool, startFakeMcpServer, type FakeMcpServer, type FakeTool } from "../../helpers/fake-mcp-server.js";
import { testMcp } from "../../helpers/mcp-extension.js";
import { useTestDb } from "../../helpers/test-db.js";
import { testExtension, testTool } from "../../helpers/test-extension.js";
import type { McpServers } from "../../../extensions/mcp/servers.js";

const fakes: FakeMcpServer[] = [];

afterEach(async () => {
  await Promise.all(fakes.splice(0).map(fake => fake.stop()));
});

async function fakeServer(tools: FakeTool[]): Promise<FakeMcpServer> {
  const fake = await startFakeMcpServer({ tools });
  fakes.push(fake);
  return fake;
}

/** A tool's run that answers `text`. */
const answer = (text: string) => () => ({ content: [{ type: "text" as const, text }] });

const listProjects: FakeTool = { name: "list_projects", description: "Lists the team's projects", inputSchema: { type: "object" } };

/** An app with the MCP extension (and `others` after it), and a script runner of a session. */
function app(others: Parameters<typeof createAppState>[1] = {}): { state: TestAppState; servers: McpServers; script(code: string): Promise<string> } {
  const mcp = testMcp();
  const state = createAppState(undefined, { extensions: [mcp.registration, ...(others.extensions ?? [])] });
  const models = new Models(state);
  const ctx: ApiContext = { projectId: 1, sessionId: "caller", taskId: null, broadcast: models.broadcast, sourceId: 0, nodes: state.nodes, models };
  return {
    state,
    servers: mcp.servers,
    async script(code) {
      const result = await runScript(ctx, code);
      if (!result.ok) throw new Error(result.error);
      return result.text;
    },
  };
}

describe("MCP tools through api.tools", () => {
  useTestDb();

  test("an agent finds the enabled servers' tools by a query, by IDs of <server>__<tool>, and calls one", async () => {
    const { servers, script } = app();
    const tools = await fakeServer([echoTool, listProjects]);
    const other = await fakeServer([{ ...listProjects, description: "Lists other projects" }]);
    servers.create({ name: "tools", url: tools.url, authKind: "none" });
    servers.create({ name: "other-one", url: other.url, authKind: "none" });
    servers.create({ name: "off", url: other.url, authKind: "none", enabled: false });

    const found = await script(`return await api.tools.search("PROJECTS")`);
    const echoed = await script(`return await api.tools.call("tools__echo", { text: "hello" })`);

    expect(found).toContain(`MCP servers: 2 tools match "PROJECTS".`);
    expect(found).toContain(`  /** Lists the team's projects */\n  tools__list_projects(args?: {}): Promise<ToolResult>;`);
    expect(found).toContain(`  /** Lists other projects */\n  "other-one__list_projects"(args?: {}): Promise<ToolResult>;`);
    expect(found).not.toContain("echo(");
    expect(JSON.parse(echoed)).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  test("the server filter limits a search to one server; an unknown one names the servers there are", async () => {
    const { servers, script } = app();
    const tools = await fakeServer([echoTool, listProjects]);
    const other = await fakeServer([listProjects]);
    servers.create({ name: "tools", url: tools.url, authKind: "none" });
    servers.create({ name: "other", url: other.url, authKind: "none" });

    const one = await script(`return await api.tools.search("", { server: "tools" })`);
    const unknown = await script(`return await api.tools.search("", { server: "nope" })`);

    expect(one).toContain("MCP servers: 2 tools.");
    expect(one).toContain("tools__echo(");
    expect(one).not.toContain("other__");
    expect(unknown).toContain("MCP servers: MCP server not found: nope (the servers: other, tools)");
  });

  test("a server that cannot be used is reported when a search finds nothing, and fails a call with why", async () => {
    const { servers, script } = app();
    const fake = await fakeServer([{ name: "deploy", inputSchema: { type: "object" }, run: () => ({ content: [{ type: "text", text: "No such project" }], isError: true }) }]);
    servers.create({ name: "tools", url: fake.url, authKind: "none" });
    servers.create({ name: "vercel", url: "https://mcp.vercel.invalid", authKind: "oauth" });

    const filtered = await script(`return await api.tools.search("projects", { server: "vercel" })`);
    const nothing = await script(`return await api.tools.search("projects")`);
    const failed = await script(`return await api.tools.call("tools__deploy", { project: "x" })`);
    const signedOut = script(`return await api.tools.call("vercel__list_projects")`);

    expect(filtered).toContain("MCP servers: MCP server vercel needs sign-in");
    expect(nothing).toContain("MCP servers: No tool matches; these servers could not be searched: MCP server vercel needs sign-in");
    expect(JSON.parse(failed)).toEqual({ content: [{ type: "text", text: "No such project" }], isError: true });
    expect(signedOut).rejects.toThrow("MCP server vercel needs sign-in");
  });

  test("an ID of no server is not MCP's, and goes to the next source; one of a server's unknown tools fails", async () => {
    const other = testExtension({ title: "Other", tools: [testTool("nope__echo")] });
    const { servers, script } = app({ extensions: [{ name: "other", register: other.register }] });
    const fake = await fakeServer([echoTool]);
    servers.create({ name: "tools", url: fake.url, authKind: "none" });

    expect(JSON.parse(await script(`return await api.tools.call("nope__echo", { text: "x" })`))).toEqual({ content: [{ type: "text", text: "Other: nope__echo {\"text\":\"x\"}" }] });
    expect(script(`return await api.tools.call("tools__shout", {})`)).rejects.toThrow("Unknown tool tools__shout: tools has no such tool");
    expect(script(`return await api.tools.call("nothing", {})`)).rejects.toThrow("Unknown tool: nothing");
  });

  test("a tool name outside [a-zA-Z0-9_-], or too long, or the same as another once changed, gets an ID that still calls it", async () => {
    const { servers, script } = app();
    const long = `get_${"x".repeat(80)}`;
    const fake = await fakeServer([
      { name: "search.v2", inputSchema: { type: "object" }, run: answer("dotted") },
      { name: "search_v2", inputSchema: { type: "object" }, run: answer("underscored") },
      { name: long, inputSchema: { type: "object" }, run: answer("long") },
    ]);
    servers.create({ name: "gh", url: fake.url, authKind: "none" });

    const ids = [...(await script(`return await api.tools.search("", { server: "gh" })`)).matchAll(/^ {2}"?([\w-]+)"?\(/gm)].map(match => match[1]!);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^gh__[a-zA-Z0-9_-]{1,60}$/);
    const answers = await Promise.all(ids.map(async id => JSON.parse(await script(`return await api.tools.call(${JSON.stringify(id)})`)).content[0].text));
    expect(answers.toSorted()).toEqual(["dotted", "long", "underscored"]);
  });
});
