import { afterEach, describe, expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { echoTool, startFakeMcpServer, type FakeMcpServer } from "../helpers/fake-mcp-server.js";
import { Models } from "../../models/models.js";
import type { ServerMessage } from "../../models/broadcast.js";
import { McpServerUnavailableError } from "../../mcp/connections.js";

const fakes: FakeMcpServer[] = [];

async function fakeServer(options?: Parameters<typeof startFakeMcpServer>[0]): Promise<FakeMcpServer> {
  const fake = await startFakeMcpServer(options);
  fakes.push(fake);
  return fake;
}

afterEach(async () => {
  await Promise.all(fakes.splice(0).map(fake => fake.stop()));
});

/** An app state whose broadcasts the test reads (`messages`). */
function observedState(options: Parameters<typeof createAppState>[1] = {}): { state: TestAppState; models: Models; messages: ServerMessage[] } {
  const messages: ServerMessage[] = [];
  const state = createAppState({ clients: new Set([{ ws: { send: (frame: string) => { messages.push(JSON.parse(frame)); return 0; } } }]) }, options);
  return { state, models: new Models(state), messages };
}

/** Signs in as the user would, through the model (the routes' own test covers the HTTP side). */
async function signIn(models: Models, fake: FakeMcpServer, serverId: number): Promise<void> {
  const { authorizationUrl } = await models.mcpServers.startSignIn(serverId, "http://localhost/oauth/mcp/callback");
  const callback = await fake.authorize(authorizationUrl);
  await models.mcpServers.finishSignIn({ state: callback.searchParams.get("state"), code: callback.searchParams.get("code") });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("McpServers", () => {
  useTestDb();

  test("callers share one connection to a server, and a tool call answers its typed result", async () => {
    const { models } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });

    const [tools, result, again] = await Promise.all([
      models.mcpServers.listTools(id),
      models.mcpServers.callTool(id, "echo", { text: "hello" }),
      models.mcpServers.callTool(id, "unknown", {}),
    ]);

    expect(tools.map(tool => tool.name)).toEqual(["echo"]);
    expect(result).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect(again).toEqual({ content: [{ type: "text", text: "Unknown tool unknown" }], isError: true });
    expect(fake.sessionsOpened).toBe(1);
  });

  test("a tool list change from the server is listed again and announced", async () => {
    const { models, messages } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });
    await models.mcpServers.listTools(id);

    fake.tools.push({ ...echoTool, name: "shout" });
    await fake.sendToolListChanged();

    await until(() => messages.some(message => message.type === "mcp_server_updated" && message.server.toolCount === 2), "the changed tool list");
    expect((await models.mcpServers.listTools(id)).map(tool => tool.name)).toEqual(["echo", "shout"]);
    expect(fake.sessionsOpened).toBe(1);
  });

  test("a call that finds its session gone (the server restarted) runs on a new connection", async () => {
    const { models } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });
    await models.mcpServers.listTools(id);

    fake.dropSessions();

    expect(await models.mcpServers.callTool(id, "echo", { text: "again" })).toEqual({ content: [{ type: "text", text: "again" }] });
    expect(fake.sessionsOpened).toBe(2);
  });

  test("a server that goes away fails its calls with its status, and a later call connects again", async () => {
    const { models } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });
    await models.mcpServers.listTools(id);

    await fake.stop();
    fakes.splice(0);
    const failure = await models.mcpServers.callTool(id, "echo", { text: "x" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpServerUnavailableError);
    expect(models.mcpServers.get(id).status).toEqual({ state: "error", message: expect.any(String) });

    const back = await fakeServer();
    await models.mcpServers.update(id, { url: back.url });
    expect(await models.mcpServers.callTool(id, "echo", { text: "back" })).toEqual({ content: [{ type: "text", text: "back" }] });
    expect(models.mcpServers.get(id).status).toEqual({ state: "connected" });
  });

  test("an expired access token is refreshed and the call goes through", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);
    await models.mcpServers.listTools(id);

    fake.expireAccessTokens();

    expect(await models.mcpServers.callTool(id, "echo", { text: "fresh" })).toEqual({ content: [{ type: "text", text: "fresh" }] });
    expect(fake.tokenRequests).toEqual(["authorization_code", "refresh_token"]);
    expect(models.mcpServers.get(id)).toMatchObject({ signedIn: true, status: { state: "connected" } });
  });

  test("calls refreshing at once keep the server signed in, though each refresh rotates the refresh token", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);
    await models.mcpServers.listTools(id);

    fake.expireAccessTokens();
    const results = await Promise.all(["a", "b", "c"].map(text => models.mcpServers.callTool(id, "echo", { text })));

    expect(results.map(result => result.content)).toEqual([[{ type: "text", text: "a" }], [{ type: "text", text: "b" }], [{ type: "text", text: "c" }]]);
    expect(models.mcpServers.get(id)).toMatchObject({ signedIn: true, status: { state: "connected" } });
  });

  test("a sign-in from another origin registers a client that replaces the signed-in one only once it completes", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);
    await models.mcpServers.listTools(id);

    const elsewhere = await models.mcpServers.startSignIn(id, "https://reins.invalid/oauth/mcp/callback");
    fake.expireAccessTokens();
    expect(await models.mcpServers.callTool(id, "echo", { text: "kept" })).toEqual({ content: [{ type: "text", text: "kept" }] });

    const callback = await fake.authorize(elsewhere.authorizationUrl);
    await models.mcpServers.finishSignIn({ state: callback.searchParams.get("state"), code: callback.searchParams.get("code") });
    fake.expireAccessTokens();
    expect(await models.mcpServers.callTool(id, "echo", { text: "moved" })).toEqual({ content: [{ type: "text", text: "moved" }] });
    expect(fake.registrations.size).toBe(2);
    expect(fake.tokenRequests).toEqual(["authorization_code", "refresh_token", "authorization_code", "refresh_token"]);
    expect(models.mcpServers.get(id)).toMatchObject({ signedIn: true, status: { state: "connected" } });
  });

  test("a sign-in whose code exchange fails leaves the server signed in as it was", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);

    const again = await models.mcpServers.startSignIn(id, "http://localhost/oauth/mcp/callback");
    const callback = await fake.authorize(again.authorizationUrl);
    const failure = await models.mcpServers.finishSignIn({ state: callback.searchParams.get("state"), code: "not-the-code" }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "McpSignInError" });
    expect(models.mcpServers.get(id)).toMatchObject({ signedIn: true });
    expect(await models.mcpServers.callTool(id, "echo", { text: "still" })).toEqual({ content: [{ type: "text", text: "still" }] });
  });

  test("tokens that no longer refresh (revoked) leave the server needing sign-in", async () => {
    const { models, messages } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);
    await models.mcpServers.listTools(id);

    fake.revokeTokens();
    const failure = await models.mcpServers.callTool(id, "echo", { text: "x" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpServerUnavailableError);
    expect(failure).toMatchObject({ status: { state: "needs_sign_in" } });
    expect(models.mcpServers.get(id)).toMatchObject({ signedIn: false, status: { state: "needs_sign_in" } });
    expect(messages.at(-1)).toMatchObject({ type: "mcp_server_updated", server: { id, status: { state: "needs_sign_in" } } });
  });

  test("a caller that stops waiting for the tool list leaves the listing to finish for the next caller", async () => {
    const { models } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "slow", url: fake.url, authKind: "none" });
    const release = fake.holdToolLists();
    const controller = new AbortController();

    const gaveUp = models.mcpServers.listTools(id, { signal: controller.signal }).catch((error: unknown) => error);
    await until(() => fake.toolListings === 1, "the server to receive the listing");
    controller.abort(new Error("search deadline"));
    expect(await gaveUp).toMatchObject({ message: "search deadline" });
    release();
    const tools = await models.mcpServers.listTools(id);

    expect(tools.map(tool => tool.name)).toEqual(["echo"]);
    expect(fake.toolListings).toBe(1);
    expect(models.mcpServers.get(id).status).toEqual({ state: "connected" });
  });

  test("a tool call times out, or is cancelled by its caller, and the connection stays usable", async () => {
    const { models } = observedState();
    const cancelled: string[] = [];
    const fake = await fakeServer({
      tools: [echoTool, {
        name: "wait",
        inputSchema: { type: "object" },
        run: (_args, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => { cancelled.push("wait"); reject(new Error("cancelled")); })),
      }],
    });
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });

    const timedOut = await models.mcpServers.callTool(id, "wait", {}, { timeoutMs: 50 }).catch((error: unknown) => error);
    const controller = new AbortController();
    const aborted = models.mcpServers.callTool(id, "wait", {}, { signal: controller.signal }).catch((error: unknown) => error);
    await Bun.sleep(20);
    controller.abort(new Error("user stopped"));

    expect(timedOut).toBeInstanceOf(McpError);
    expect(timedOut).toMatchObject({ code: ErrorCode.RequestTimeout });
    expect(await aborted).toMatchObject({ message: expect.stringContaining("user stopped") });
    await until(() => cancelled.length === 2, "the server to see both cancellations");
    expect(await models.mcpServers.callTool(id, "echo", { text: "still here" })).toEqual({ content: [{ type: "text", text: "still here" }] });
    expect(fake.sessionsOpened).toBe(1);
  });

  test("an idle connection is closed, and the next call opens another", async () => {
    const { models } = observedState({ mcp: { idleMs: 30 } });
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });
    await models.mcpServers.listTools(id);

    await until(() => models.mcpServers.get(id).status.state === "not_connected", "the idle close");
    await models.mcpServers.listTools(id);

    expect(fake.sessionsOpened).toBe(2);
  });

  test("a server that speaks only the legacy SSE transport is reached through it", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ legacySse: true });
    const { id } = models.mcpServers.create({ name: "legacy", url: fake.url, authKind: "none" });

    expect((await models.mcpServers.listTools(id)).map(tool => tool.name)).toEqual(["echo"]);
    expect(await models.mcpServers.callTool(id, "echo", { text: "old" })).toEqual({ content: [{ type: "text", text: "old" }] });
  });

  test("a stopped app's connections are closed and it connects nothing more", async () => {
    const { state, models } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });
    await models.mcpServers.listTools(id);

    await state.mcp.close();

    expect(models.mcpServers.get(id).status).toEqual({ state: "not_connected" });
    expect(await models.mcpServers.listTools(id).catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(fake.sessionsOpened).toBe(1);
  });
});
