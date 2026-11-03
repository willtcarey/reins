import { afterEach, describe, expect, test } from "bun:test";
import { runScript } from "../../../tools/execute.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { echoTool, startFakeMcpServer, type FakeMcpServer, type FakeTool } from "../../helpers/fake-mcp-server.js";
import { testMcp } from "../../helpers/mcp-extension.js";
import { useTestDb } from "../../helpers/test-db.js";
import { testExtension, testTool } from "../../helpers/test-extension.js";
import type { McpServers } from "../../../extensions/mcp/servers.js";
import { scriptContext } from "../../helpers/script-context.js";

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
  const ctx = () => scriptContext(state, { sessionId: "caller" });
  return {
    state,
    servers: mcp.servers,
    async script(code) {
      const result = await runScript(ctx(), code);
      if (!result.ok) throw new Error(result.error);
      return result.text;
    },
  };
}

describe("MCP tools through api.tools", () => {
  useTestDb();

  test("an agent finds the enabled servers' tools by a query, by IDs of mcp__<server>__<tool>, and calls one", async () => {
    const { servers, script } = app();
    const tools = await fakeServer([echoTool, listProjects]);
    const other = await fakeServer([{ ...listProjects, description: "Lists other projects" }]);
    await servers.create({ name: "tools", url: tools.url, authKind: "none" });
    await servers.create({ name: "other-one", url: other.url, authKind: "none" });
    await servers.create({ name: "off", url: other.url, authKind: "none", enabled: false });

    const found = await script(`return await api.tools.search("PROJECTS")`);
    const echoed = await script(`return await api.tools.call("mcp__tools__echo", { text: "hello" })`);

    expect(found).toContain(`MCP servers: 2 tools match "PROJECTS".`);
    expect(found).toContain(`  /** Lists the team's projects */\n  mcp__tools__list_projects(args?: {}): Promise<ToolResult>;`);
    expect(found).toContain(`  /** Lists other projects */\n  "mcp__other-one__list_projects"(args?: {}): Promise<ToolResult>;`);
    expect(found).not.toContain("echo(");
    expect(JSON.parse(echoed)).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  test("the server filter limits a search to one server; an unknown one names the servers there are", async () => {
    const { servers, script } = app();
    const tools = await fakeServer([echoTool, listProjects]);
    const other = await fakeServer([listProjects]);
    await servers.create({ name: "tools", url: tools.url, authKind: "none" });
    await servers.create({ name: "other", url: other.url, authKind: "none" });

    const one = await script(`return await api.tools.search("", { server: "tools" })`);
    const unknown = await script(`return await api.tools.search("", { server: "nope" })`);

    expect(one).toContain("MCP servers: 2 tools.");
    expect(one).toContain("mcp__tools__echo(");
    expect(one).not.toContain("mcp__other__");
    expect(unknown).toContain("MCP servers: MCP server not found: nope (the servers: other, tools)");
  });

  test("a server that cannot be used is reported when a search finds nothing, and fails a call with why", async () => {
    const { servers, script } = app();
    const fake = await fakeServer([{ name: "deploy", inputSchema: { type: "object" }, run: () => ({ content: [{ type: "text", text: "No such project" }], isError: true }) }]);
    await servers.create({ name: "tools", url: fake.url, authKind: "none" });
    await servers.create({ name: "vercel", url: "https://mcp.vercel.invalid", authKind: "oauth" });

    const filtered = await script(`return await api.tools.search("projects", { server: "vercel" })`);
    const nothing = await script(`return await api.tools.search("projects")`);
    const failed = await script(`return await api.tools.call("mcp__tools__deploy", { project: "x" })`);
    const signedOut = script(`return await api.tools.call("mcp__vercel__list_projects")`);

    expect(filtered).toContain("MCP servers: MCP server vercel needs sign-in");
    expect(nothing).toContain("MCP servers: No tool matches; these servers could not be searched: MCP server vercel needs sign-in");
    expect(JSON.parse(failed)).toEqual({ content: [{ type: "text", text: "No such project" }], isError: true });
    expect(signedOut).rejects.toThrow("MCP server vercel needs sign-in");
  });

  test("a call reaches MCP by its prefix: an ID of no server, or of a server's unknown tool, fails; another extension's ID is its own", async () => {
    const other = testExtension({ title: "Other", tools: [testTool("tools__echo")] });
    const { servers, script } = app({ extensions: [{ name: "other", register: other.register }] });
    const fake = await fakeServer([echoTool]);
    await servers.create({ name: "tools", url: fake.url, authKind: "none" });

    expect(JSON.parse(await script(`return await api.tools.call("other__tools__echo", { text: "x" })`))).toEqual({ content: [{ type: "text", text: "Other: tools__echo {\"text\":\"x\"}" }] });
    expect(script(`return await api.tools.call("mcp__nope__echo", {})`)).rejects.toThrow("Unknown tool mcp__nope__echo: there is no MCP server nope");
    expect(script(`return await api.tools.call("mcp__echo", {})`)).rejects.toThrow("Unknown tool mcp__echo: an MCP tool's ID is mcp__<server>__<tool>");
    expect(script(`return await api.tools.call("mcp__tools__shout", {})`)).rejects.toThrow("Unknown tool mcp__tools__shout: tools has no such tool");
  });

  test("a query that is a tool's ID or name finds it first", async () => {
    const { servers, script } = app();
    const fake = await fakeServer([{ ...listProjects, name: "list_projects_all", description: "Like list_projects, for every team" }, listProjects]);
    await servers.create({ name: "vercel", url: fake.url, authKind: "none" });
    const first = async (query: string) => /^ {2}(\w+)\(/m.exec(await script(`return await api.tools.search(${JSON.stringify(query)})`))?.[1];

    for (const query of ["mcp__vercel__list_projects", "vercel__list_projects", "list_projects"]) {
      expect(await first(query)).toBe("mcp__vercel__list_projects");
    }
  });

  test("a tool name outside [a-zA-Z0-9_-], or too long, or the same as another once changed, gets an ID that still calls it", async () => {
    const { servers, script } = app();
    const long = `get_${"x".repeat(80)}`;
    const fake = await fakeServer([
      { name: "search.v2", inputSchema: { type: "object" }, run: answer("dotted") },
      { name: "search_v2", inputSchema: { type: "object" }, run: answer("underscored") },
      { name: long, inputSchema: { type: "object" }, run: answer("long") },
    ]);
    await servers.create({ name: "gh", url: fake.url, authKind: "none" });

    const ids = [...(await script(`return await api.tools.search("", { server: "gh" })`)).matchAll(/^ {2}"?([\w-]+)"?\(/gm)].map(match => match[1]!);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^mcp__gh__[a-zA-Z0-9_-]+$/);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(64);
    expect(ids).toContain(`mcp__gh__get_${"x".repeat(64 - "mcp__gh__get_".length - 9)}_${new Bun.CryptoHasher("sha256").update(long).digest("hex").slice(0, 8)}`);
    const answers = await Promise.all(ids.map(async id => JSON.parse(await script(`return await api.tools.call(${JSON.stringify(id)})`)).content[0].text));
    expect(answers.toSorted()).toEqual(["dotted", "long", "underscored"]);
  });
});
