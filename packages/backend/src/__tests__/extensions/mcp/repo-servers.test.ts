import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptContext, ServerSdk } from "@reins/sdk/server";
import { runScript } from "../../../tools/execute.js";
import { scriptingApi } from "../../../sdk-host/scripts.js";
import { upsertSource } from "../../../node-store.js";
import { buildRouter } from "../../../routes/index.js";
import { Models } from "../../../models/models.js";
import { createProject } from "../../project-fixture.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { loopbackLink, stopLoopbackNode, SEEDED_NODE_ID } from "../../helpers/loopback-node.js";
import { fakeStdioServer } from "../../helpers/fake-stdio-mcp-server.js";
import { echoTool, startFakeMcpServer, type FakeMcpServer, type FakeTool } from "../../helpers/fake-mcp-server.js";
import { testMcp } from "../../helpers/mcp-extension.js";
import { scriptContext } from "../../helpers/script-context.js";
import { useTestDb } from "../../helpers/test-db.js";
import { useFakeModel } from "../../helpers/fake-model.js";
import type { McpSessionServersView, McpRepoServerView, McpRepoStdioServerView } from "../../../extensions/mcp/repo-servers.js";

setDefaultTimeout(20_000);

const router = buildRouter();
const named = (name: string): FakeTool => ({ ...echoTool, name });

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups = [];
});

/**
 * An app with the MCP extension on a loopback node, and a project with two checkouts of its own (`main` and `branch`,
 * as two worktrees on different branches), each with a session. `write` puts a `.mcp.json` in a checkout; `open` opens
 * a session's runtime (its prompt is built: the file is read); `api` calls MCP's HTTP API as the user's browser does,
 * or with `{ browser: false }` as a command would.
 */
async function app(model: { provider: string; modelId: string }) {
  const mcp = testMcp();
  let caller: ServerSdk | undefined;
  const state: TestAppState = createAppState(undefined, {
    loopbackNode: true,
    extensions: [mcp.registration, { name: "caller", register: sdk => { caller = sdk; return () => {}; } }],
  });
  cleanups.push(async () => {
    await state.extensions.dispose();
    await stopLoopbackNode(state);
    await state.nodes.close();
  });
  await loopbackLink(state).ready();
  await state.extensions.loaded;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reins-repo-mcp-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const checkouts = { main: join(dir, "main"), branch: join(dir, "branch"), other: join(dir, "other") };
  for (const checkout of Object.values(checkouts)) mkdirSync(join(checkout, "web"), { recursive: true });
  const project = createProject("Merch", checkouts.main);
  const sessions = {
    main: await newSession(state, model, project.id, checkouts.main),
    branch: await newSession(state, model, project.id, checkouts.branch),
  };
  const write = (checkout: string, mcpServers: unknown) => writeFileSync(join(checkout, ".mcp.json"), JSON.stringify({ mcpServers }));
  const open = async (sessionId: string): Promise<string> => {
    const session = new Models(state).sessions.get(sessionId).row;
    const context: PromptContext = { session: { id: sessionId, projectId: session.project_id, taskId: null }, task: null, tools: null };
    return (await state.extensions.host.promptSections(context)).join("\n");
  };
  const api = async (method: string, input?: unknown, { browser = true, headers = {} }: { browser?: boolean; headers?: Record<string, string> } = {}) => {
    const request = new Request(`http://localhost/api/extensions/mcp/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(browser ? { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" } : {}), ...headers },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const response = (await router.handle(request, state))!;
    return { status: response.status, json: response.status === 204 ? null : await response.json() };
  };
  /** A session's MCP servers list, as its Inspector view loads it. */
  const view = async (sessionId = sessions.main): Promise<McpSessionServersView> => (await api("sessionServers", { sessionId })).json;
  const server = async (name: string, sessionId = sessions.main): Promise<McpRepoServerView> => {
    const found = (await view(sessionId)).servers.find(candidate => candidate.name === name);
    if (!found) throw new Error(`No repo server ${name}`);
    return found;
  };
  const stdioServer = async (name: string): Promise<McpRepoStdioServerView> => {
    const found = await server(name);
    if (found.transport !== "stdio") throw new Error(`${name} is not a stdio server`);
    return found;
  };
  /** The user flips a server's toggle in a session's list (from a browser, unless told otherwise). */
  const toggle = async (sessionId: string, name: string, allowed: boolean, options: { browser?: boolean; headers?: Record<string, string> } = {}) =>
    api("allow", { id: (await server(name, sessionId)).id, allowed, sessionId }, options);
  /** Runs `code` as a script of `sessionId`: its result, or its error. */
  const script = async (sessionId: string, code: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
    const result = await runScript(scriptContext(state, { sessionId }), code);
    return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error };
  };
  const call = async (sessionId: string, id: string, args: object = {}) => {
    const result = await script(sessionId, `return await reins.tools.call(${JSON.stringify(id)}, ${JSON.stringify(args)})`);
    if (!result.ok) return { error: result.error };
    const parsed: { content: Array<{ text: string }> } = JSON.parse(result.text);
    return { text: parsed.content[0]!.text };
  };
  const log = join(dir, "starts.log");
  const starts = () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  const fakes: FakeMcpServer[] = [];
  const fake = async (options: Parameters<typeof startFakeMcpServer>[0] = {}) => {
    const started = await startFakeMcpServer(options);
    fakes.push(started);
    cleanups.push(() => started.stop());
    return started;
  };
  const session = (projectId: number | null, checkout: string) => newSession(state, model, projectId, checkout);
  return { state, session, servers: mcp.servers, caller: () => caller!, project, sessions, checkouts, write, open, api, view, server, stdioServer, toggle, script, call, log, starts, fake };
}

async function newSession(state: TestAppState, model: { provider: string; modelId: string }, projectId: number | null, checkout: string): Promise<string> {
  const source = upsertSource(SEEDED_NODE_ID, checkout).id;
  return (await new Models(state).sessions.create({ ...(projectId === null ? {} : { projectId }), source, model })).id;
}

const shopify = { command: process.execPath, args: [fakeStdioServer.args[0]!] };

describe("repo MCP servers (.mcp.json)", () => {
  useTestDb();
  const model = useFakeModel();

  test("a session's runtime reads its own checkout's .mcp.json: HTTP and stdio entries, and the entries skipped with why", async () => {
    const { write, open, sessions, checkouts, view } = await app(model.model);
    write(checkouts.main, {
      stripe: { type: "http", url: "https://mcp.stripe.com" },
      docs: { url: "https://docs.example.com/sse", type: "sse", headers: { "X-Team": "${TEAM:-core}" } },
      "shopify-dev": { command: "npx", args: ["-y", "@shopify/dev-mcp@latest"], env: { SHOPIFY_TOKEN: "${SHOPIFY_TOKEN}" } },
      Shopify_Dev: { command: "npx" },
      socket: { type: "websocket", url: "wss://example.com" },
      both: { command: "npx", url: "https://example.com" },
      empty: {},
      outside: { command: "npx", cwd: "../elsewhere" },
    });
    write(checkouts.branch, { other: { url: "https://other.example.com/mcp" } });

    const prompt = await open(sessions.main);
    const project = await view();

    expect(prompt).toContain("- docs: from this project's .mcp.json.");
    expect(prompt).toContain("- stripe: from this project's .mcp.json.");
    expect(prompt).not.toContain("- shopify-dev: from this project's .mcp.json.");
    expect(prompt).toContain("Disabled (you can ask the user to turn these on with /mcp):\n- shopify-dev");
    expect(prompt).not.toContain("- other");
    expect(project.file).toEqual({ state: "read", error: null, sessionId: sessions.main, readAt: expect.any(String) });
    expect(project.servers.map(server => [server.name, server.transport, server.status.state])).toEqual([
      ["docs", "sse", "ready"], ["shopify-dev", "stdio", "off"], ["stripe", "http", "ready"],
    ]);
    expect(project.servers[0]).toMatchObject({ url: "https://docs.example.com/sse", headerNames: ["X-Team"], variables: [{ name: "TEAM", set: false }], signedIn: false });
    expect(project.servers[1]).toMatchObject({
      version: { command: "npx", args: ["-y", "@shopify/dev-mcp@latest"], cwd: null, envNames: ["SHOPIFY_TOKEN"] },
      allowed: false, changed: false, status: { state: "off" }, variables: [{ name: "SHOPIFY_TOKEN", set: false }],
    });
    expect(project.servers[1]).not.toHaveProperty("warnings");
    expect(project.skipped).toEqual([
      { name: "Shopify_Dev", reason: expect.stringContaining("must start with a lowercase letter") },
      { name: "socket", reason: "Unknown type \"websocket\" (stdio, http or sse)" },
      { name: "both", reason: "It has both a command and a url: give its type" },
      { name: "empty", reason: "It has neither a command nor a url" },
      { name: "outside", reason: "Its cwd must be a directory inside the checkout" },
    ]);
  });

  test("a missing or invalid file gives a session no repo servers, and its list says why", async () => {
    const { write, open, sessions, checkouts, view, servers } = await app(model.model);
    await servers.create({ name: "vercel", url: "https://vercel.example.com/mcp" });

    const missing = await open(sessions.main);
    const missingFile = (await view()).file;
    writeFileSync(join(checkouts.main, ".mcp.json"), "{ \"mcpServers\": ");
    const invalid = await open(sessions.main);
    const invalidView = await view();

    expect(missing).toContain("- vercel");
    expect(missingFile).toMatchObject({ state: "missing", error: null });
    expect(invalid).toContain("- vercel");
    expect(invalidView.file).toMatchObject({ state: "invalid", error: expect.stringContaining("Not valid JSON") });
    expect(invalidView.servers).toEqual([]);
    write(checkouts.main, { stripe: { url: "https://mcp.stripe.com" } });
    expect(await open(sessions.main)).toContain("- stripe");
  });

  test("a repo entry with the name of one of the user's own servers is skipped: theirs answers, and the list says why", async () => {
    const { write, open, sessions, checkouts, servers, call, view, fake } = await app(model.model);
    const own = await fake({ tools: [named("own_tool")] });
    const repo = await fake({ tools: [named("repo_tool")] });
    await servers.create({ name: "docs", url: own.url });
    write(checkouts.main, { docs: { url: repo.url } });
    const prompt = await open(sessions.main);

    const ownTool = await call(sessions.main, "mcp__docs__own_tool", { text: "own" });
    const repoTool = await call(sessions.main, "mcp__docs__repo_tool", { text: "repo" });
    const list = await view(sessions.main);

    expect(ownTool).toEqual({ text: "own" });
    expect(repoTool.error).toContain("docs has no such tool");
    expect(prompt).not.toContain("- docs: from this project's .mcp.json");
    expect(list.servers).toEqual([]);
    expect(list.skipped).toEqual([{ name: "docs", reason: expect.stringContaining("one of your own MCP servers (Settings → MCP) has this name") }]);
  });

  test("${VAR} and ${VAR:-default} expand in header values from the project's values, never from Reins' environment; one without a value is the server's error", async () => {
    const { write, open, sessions, checkouts, call, api, server, view, fake } = await app(model.model);
    const keyed = await fake({ auth: { kind: "header", name: "X-Api-Key", value: "sk-secret" } });
    write(checkouts.main, { keyed: { url: keyed.url, headers: { "X-Api-Key": "${KEY_PREFIX:-sk}-${KEYED_TOKEN}" } } });
    // The Reins server's own environment is never read: the file could send any of its variables anywhere.
    process.env.KEYED_TOKEN = "secret";
    cleanups.push(() => { delete process.env.KEYED_TOKEN; });
    await open(sessions.main);

    const without = await call(sessions.main, "mcp__keyed__echo", { text: "hi" });
    const { id } = await server("keyed");
    expect((await api("setVariables", { id, values: { KEYED_TOKEN: "secret" } })).status).toBe(204);
    const withValue = await call(sessions.main, "mcp__keyed__echo", { text: "hi" });

    expect(without.error).toContain("Its headers need a value for KEYED_TOKEN");
    expect(withValue).toEqual({ text: "hi" });
    expect(await server("keyed")).toMatchObject({ status: { state: "ready" }, variables: [{ name: "KEY_PREFIX", set: false }, { name: "KEYED_TOKEN", set: true }] });
    expect(JSON.stringify(await view())).not.toContain("secret\"");
  });

  test("an HTTP entry's sign-in is the project's: it needs one once the server asks, and a changed URL signs the user out", async () => {
    const { state, session, write, open, sessions, checkouts, call, api, server, fake } = await app(model.model);
    const stripe = await fake({ auth: { kind: "oauth" } });
    const moved = await fake({ auth: { kind: "oauth" } });
    write(checkouts.main, { stripe: { type: "http", url: stripe.url } });
    await open(sessions.main);
    const other = createProject("Other", checkouts.other);
    write(checkouts.other, { stripe: { type: "http", url: stripe.url } });
    const otherSession = await session(other.id, checkouts.other);
    await open(otherSession);

    const before = await call(sessions.main, "mcp__stripe__echo", { text: "hi" });
    const { id } = await server("stripe");
    const started = await api("signIn", { id });
    const callback = await stripe.authorize(started.json.authorizationUrl);
    expect((await router.handle(new Request(callback.href), state))!.status).toBe(200);
    const signedIn = await call(sessions.main, "mcp__stripe__echo", { text: "hi" });
    const otherProject = await call(otherSession, "mcp__stripe__echo", { text: "hi" });
    write(checkouts.main, { stripe: { type: "http", url: moved.url } });
    await open(sessions.main);
    const afterMove = await server("stripe");

    expect(before.error).toContain("MCP server stripe needs sign-in");
    expect(signedIn).toEqual({ text: "hi" });
    expect(otherProject.error).toContain("needs sign-in");
    expect(afterMove).toMatchObject({ url: moved.url, signedIn: false });
  });

  test("a stdio entry runs nothing and lists no tool until the user turns it on; then it runs on the session's node, in its checkout", async () => {
    const { write, open, sessions, checkouts, call, script, server, stdioServer, toggle, log, starts } = await app(model.model);
    write(checkouts.main, { "shopify-dev": { ...shopify, cwd: "web", env: { FAKE_MCP_LOG: log } } });

    await open(sessions.main);
    const search = await script(sessions.main, "return await reins.tools.search(\"echo\")");
    const filtered = await script(sessions.main, "return await reins.tools.search(\"echo\", { filters: { server: \"shopify-dev\" } })");
    const called = await call(sessions.main, "mcp__shopify-dev__echo", { text: "hi" });
    const off = await stdioServer("shopify-dev");

    expect(starts()).toBe(0);
    const found = search.ok ? search.text : search.error;
    expect(found).not.toContain("shopify-dev");
    expect(filtered.ok ? filtered.text : filtered.error).toContain("MCP servers: MCP server shopify-dev (from this project's .mcp.json) is disabled");
    expect(called.error).toContain("is disabled");
    expect(off).toMatchObject({ allowed: false, status: { state: "off" }, version: { ...shopify, cwd: "web", envNames: ["FAKE_MCP_LOG"] } });

    expect((await toggle(sessions.main, "shopify-dev", true)).status).toBe(204);
    const where: { cwd: string } = JSON.parse((await call(sessions.main, "mcp__shopify-dev__whoami")).text!);

    expect(where.cwd).toBe(join(checkouts.main, "web"));
    expect(starts()).toBe(1);
    expect(await server("shopify-dev")).toMatchObject({ allowed: true, status: { state: "ready" }, version: off.version });
  });

  test("a session's list shows a stdio server's tools, starting it in that session", async () => {
    const { write, open, sessions, checkouts, api, server, toggle, starts, log } = await app(model.model);
    write(checkouts.main, { "shopify-dev": { ...shopify, env: { FAKE_MCP_LOG: log } } });
    await open(sessions.main);
    await toggle(sessions.main, "shopify-dev", true);
    const { id } = await server("shopify-dev");

    const tools = await api("tools", { id, sessionId: sessions.main });

    expect(tools.status).toBe(200);
    expect(tools.json.map((tool: { name: string }) => tool.name)).toContain("echo");
    expect(starts()).toBe(1);
  });

  test("a session's list shows each server of its own file with its toggle; a command changed on its branch is off there, while the allowed one still runs elsewhere", async () => {
    const { write, open, sessions, checkouts, call, view, toggle, fake } = await app(model.model);
    const docs = await fake();
    write(checkouts.main, { "shopify-dev": shopify, docs: { url: docs.url } });
    write(checkouts.branch, { "shopify-dev": shopify });
    await open(sessions.main);
    await open(sessions.branch);
    const before = await view(sessions.main);
    await toggle(sessions.main, "shopify-dev", true);

    write(checkouts.branch, { "shopify-dev": { ...shopify, args: [...shopify.args, "--changed"] } });
    await open(sessions.branch);
    const onMain = await call(sessions.main, "mcp__shopify-dev__echo", { text: "main" });
    const onBranch = await call(sessions.branch, "mcp__shopify-dev__echo", { text: "branch" });
    const branchList = await view(sessions.branch);
    await toggle(sessions.branch, "shopify-dev", true);
    write(checkouts.branch, { "shopify-dev": shopify });
    await open(sessions.branch);
    const back: { args: string[] } = JSON.parse((await call(sessions.branch, "mcp__shopify-dev__whoami")).text!);

    expect(before.servers.map(server => [server.name, server.allowed, server.status.state])).toEqual([["docs", true, "ready"], ["shopify-dev", false, "off"]]);
    expect(onMain).toEqual({ text: "main" });
    expect(onBranch.error).toContain("is disabled");
    expect(branchList.servers).toMatchObject([{ name: "shopify-dev", allowed: false, changed: true, version: { args: [...shopify.args, "--changed"] } }]);
    expect(back.args).toEqual([]);
  });

  test("turning a server off stops it for the project; turning it on again needs nothing more", async () => {
    const { write, open, sessions, checkouts, call, toggle, fake } = await app(model.model);
    const docs = await fake();
    write(checkouts.main, { "shopify-dev": shopify, docs: { url: docs.url } });
    write(checkouts.branch, { "shopify-dev": { ...shopify, args: [...shopify.args, "--other"] } });
    await open(sessions.main);
    await toggle(sessions.main, "shopify-dev", true);
    await open(sessions.branch);

    await toggle(sessions.main, "shopify-dev", false);
    await toggle(sessions.main, "docs", false);
    const offPrompt = await open(sessions.main);
    const stdioOff = await call(sessions.main, "mcp__shopify-dev__echo", { text: "hi" });
    const httpOff = await call(sessions.main, "mcp__docs__echo", { text: "hi" });
    await toggle(sessions.main, "shopify-dev", true);
    const onAgain = await call(sessions.main, "mcp__shopify-dev__echo", { text: "again" });

    expect(offPrompt).not.toContain("- docs: from this project's .mcp.json.");
    expect(offPrompt).not.toContain("- shopify-dev: from this project's .mcp.json.");
    expect(offPrompt).toContain("Disabled (you can ask the user to turn these on with /mcp):\n- docs\n- shopify-dev");
    expect(stdioOff.error).toContain("MCP server shopify-dev (from this project's .mcp.json) is disabled");
    expect(httpOff.error).toContain("MCP server docs (from this project's .mcp.json) is disabled");
    expect(onAgain).toEqual({ text: "again" });
  });

  test("env ${VAR}s expand from the project's values, else the node's environment, else their default", async () => {
    const { write, open, sessions, checkouts, call, api, server, toggle } = await app(model.model);
    process.env.REINS_TEST_NODE_VALUE = "from the node";
    cleanups.push(() => { delete process.env.REINS_TEST_NODE_VALUE; });
    write(checkouts.main, { "shopify-dev": { ...shopify, env: { FAKE_TOKEN: "${GIVEN}|${REINS_TEST_NODE_VALUE}|${UNSET_ONE:-fallback}" } } });
    await open(sessions.main);
    await toggle(sessions.main, "shopify-dev", true);

    const without = await call(sessions.main, "mcp__shopify-dev__whoami");
    await api("setVariables", { id: (await server("shopify-dev")).id, values: { GIVEN: "it's given" } });
    const token: { token: string } = JSON.parse((await call(sessions.main, "mcp__shopify-dev__whoami")).text!);

    expect(without.error).toContain("Its env needs a value for GIVEN");
    expect(token.token).toBe("it's given|from the node|fallback");
  });

  test("no agent path can turn a server on: scripts, reins.mcp, tools and other extensions are refused, and so is a request that is not a browser's", async () => {
    const { state, write, open, sessions, checkouts, call, script, caller, toggle, starts, log, stdioServer } = await app(model.model);
    write(checkouts.main, { "shopify-dev": { ...shopify, env: { FAKE_MCP_LOG: log } } });
    await open(sessions.main);

    const scriptFunctions = scriptingApi(state.extensions.host).functions.map(fn => fn.name);
    const mcpMethods = await script(sessions.main, "return Object.keys(reins.mcp)");
    const update = await script(sessions.main, "return await reins.mcp.update(\"shopify-dev\", { enabled: true })");
    const fromExtension = await caller().tools.call("mcp__shopify-dev__echo", { text: "hi" }).then(() => "ran", (error: Error) => error.message);
    const notBrowser = await toggle(sessions.main, "shopify-dev", true, { browser: false });
    const viaNode = await script(sessions.main, `return await reins.nodes.run("current", "curl -s -X POST http://localhost:1/api/extensions/mcp/allow -d '{}' || true")`);

    expect(scriptFunctions).toContain("mcp.update");
    expect(scriptFunctions.filter(name => /approv|allow|answer|version/i.test(name))).toEqual([]);
    expect(mcpMethods.ok && JSON.parse(mcpMethods.text).toSorted()).toEqual(["add", "finishSignIn", "get", "list", "remove", "signIn", "signOut", "test", "update"]);
    expect(update).toMatchObject({ ok: false, error: expect.stringContaining("MCP server not found: shopify-dev") });
    expect(fromExtension).toContain("there is no MCP server shopify-dev");
    expect(notBrowser).toEqual({ status: 403, json: { error: "Only the user can turn this on or off, from Reins in their browser" } });
    expect(viaNode.ok).toBe(true);
    expect(await stdioServer("shopify-dev")).toMatchObject({ allowed: false, status: { state: "off" } });
    expect(await call(sessions.main, "mcp__shopify-dev__echo", { text: "hi" })).toMatchObject({ error: expect.stringContaining("is disabled") });
    expect(starts()).toBe(0);
  });

  test("a page over plain HTTP, whose browser sends no Fetch Metadata, can toggle by its own Origin; another site's cannot", async () => {
    const { write, open, sessions, checkouts, toggle, log } = await app(model.model);
    write(checkouts.main, { "shopify-dev": { ...shopify, env: { FAKE_MCP_LOG: log } } });
    await open(sessions.main);

    const otherSite = await toggle(sessions.main, "shopify-dev", true, { browser: false, headers: { Origin: "http://evil.example" } });
    const ownPage = await toggle(sessions.main, "shopify-dev", true, { browser: false, headers: { Origin: "http://localhost" } });

    expect(otherSite.status).toBe(403);
    expect(ownPage.status).toBe(204);
  });

  test("the file's fields, and the toggle, cannot be changed through update, and a repo server cannot be removed", async () => {
    const { write, open, sessions, checkouts, api, server, fake } = await app(model.model);
    const docs = await fake();
    write(checkouts.main, { docs: { url: docs.url } });
    await open(sessions.main);
    const { id } = await server("docs");

    const enabled = await api("update", { id, changes: { enabled: false } });
    const url = await api("update", { id, changes: { url: "https://elsewhere.example.com/mcp" } });
    const removed = await api("remove", { id });

    expect(enabled).toEqual({ status: 400, json: { error: "docs is defined by its project's .mcp.json: the user turns it on or off in a session's MCP servers list" } });
    expect(url).toEqual({ status: 400, json: { error: "docs is defined by its project's .mcp.json: change url there" } });
    expect(removed.status).toBe(400);
    expect(await server("docs")).toMatchObject({ enabled: true, allowed: true });
  });
});
