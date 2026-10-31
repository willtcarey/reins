import { afterEach, describe, expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { useTestDb } from "../helpers/test-db.js";
import { getDb } from "../../app-globals.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { echoTool, startFakeMcpServer, type FakeMcpServer } from "../helpers/fake-mcp-server.js";
import { Models } from "../../models/models.js";
import type { ServerMessage } from "../../models/broadcast.js";
import { McpServerUnavailableError } from "../../mcp/connections.js";
import { McpServerNotFoundError } from "../../models/mcp-servers.js";

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
  const { authorizationUrl } = await models.mcpServers.get(serverId).startSignIn("http://localhost/oauth/mcp/callback");
  const callback = await fake.authorize(authorizationUrl);
  await models.mcpServers.finishSignIn({ state: callback.searchParams.get("state"), code: callback.searchParams.get("code") });
}

/** The server's tokens were issued long ago, as by a sign-in or refresh days back. */
function ageTokens(serverId: number): void {
  getDb().query("UPDATE mcp_server_secrets SET updated_at = '2000-01-01T00:00:00.000Z' WHERE server_id = ? AND kind = 'tokens'").run(serverId);
}

/** Checks for tokens to refresh every 10 ms; tokens are due an hour after they were issued. */
const backgroundRefresh = { mcp: { tokenRefreshCheckMs: 10, tokenRefreshAgeMs: 3_600_000 } };

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("McpServers", () => {
  useTestDb();

  test("finds a server by ID or by name ignoring case, and not finding one names the servers there are", () => {
    const { models } = observedState();
    const { id } = models.mcpServers.create({ name: "slack", url: "https://mcp.slack.com/mcp", authKind: "oauth" });
    models.mcpServers.create({ name: "executor", url: "https://executor.example.com/mcp", authKind: "oauth" });

    expect(models.mcpServers.find(id).name).toBe("slack");
    expect(models.mcpServers.find(" Slack ").id).toBe(id);
    expect(() => models.mcpServers.find("github")).toThrow(new McpServerNotFoundError("github", ["executor", "slack"]));
    expect(() => models.mcpServers.get(id + 100)).toThrow(McpServerNotFoundError);
  });

  test("callers share one connection to a server, and a tool call answers its typed result", async () => {
    const { models } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });

    const [tools, result, again] = await Promise.all([
      models.mcpServers.get(id).listTools(),
      models.mcpServers.get(id).callTool("echo", { text: "hello" }),
      models.mcpServers.get(id).callTool("unknown", {}),
    ]);

    expect(tools.map(tool => tool.name)).toEqual(["echo"]);
    expect(result).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect(again).toEqual({ content: [{ type: "text", text: "Unknown tool unknown" }], isError: true });
    expect(fake.sessionsOpened).toBe(1);
  });

  test("after a tool list change from the server, the next caller gets the new list on the same connection", async () => {
    const { models, messages } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });
    await models.mcpServers.get(id).listTools();
    messages.splice(0);

    fake.tools.push({ ...echoTool, name: "shout" });
    await fake.sendToolListChanged();

    let names: string[] = [];
    for (let i = 0; i < 100 && names.length !== 2; i++) {
      await Bun.sleep(10);
      names = (await models.mcpServers.get(id).listTools()).map(tool => tool.name);
    }
    expect(names).toEqual(["echo", "shout"]);
    expect(fake.sessionsOpened).toBe(1);
    expect(messages).toEqual([]);
  });

  test("a call that finds its session gone (the server restarted) runs on a new connection", async () => {
    const { models } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });
    await models.mcpServers.get(id).listTools();

    fake.dropSessions();

    expect(await models.mcpServers.get(id).callTool("echo", { text: "again" })).toEqual({ content: [{ type: "text", text: "again" }] });
    expect(fake.sessionsOpened).toBe(2);
  });

  test("a server that goes away fails its calls with its status, announced, and a later call connects again", async () => {
    const { models, messages } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });
    await models.mcpServers.get(id).listTools();
    expect(messages.map(message => message.type === "mcp_server_updated" && message.server.status)).toEqual([{ state: "ready" }]);

    await fake.stop();
    fakes.splice(0);
    const failure = await models.mcpServers.get(id).callTool("echo", { text: "x" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpServerUnavailableError);
    expect(models.mcpServers.get(id).view().status).toEqual({ state: "error", message: expect.any(String) });
    expect(messages.map(message => message.type === "mcp_server_updated" && message.server.status))
      .toEqual([{ state: "ready" }, { state: "error", message: expect.any(String) }]);

    const back = await fakeServer();
    await models.mcpServers.get(id).update({ url: back.url });
    expect(await models.mcpServers.get(id).callTool("echo", { text: "back" })).toEqual({ content: [{ type: "text", text: "back" }] });
    expect(models.mcpServers.get(id).view().status).toEqual({ state: "ready" });
  });

  test("an expired access token is refreshed and the call goes through", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);
    await models.mcpServers.get(id).listTools();

    fake.expireAccessTokens();

    expect(await models.mcpServers.get(id).callTool("echo", { text: "fresh" })).toEqual({ content: [{ type: "text", text: "fresh" }] });
    expect(fake.tokenRequests).toEqual(["authorization_code", "refresh_token"]);
    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: true, status: { state: "ready" } });
  });

  test("calls refreshing at once keep the server signed in, though each refresh rotates the refresh token", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);
    await models.mcpServers.get(id).listTools();

    fake.expireAccessTokens();
    const results = await Promise.all(["a", "b", "c"].map(text => models.mcpServers.get(id).callTool("echo", { text })));

    expect(results.map(result => result.content)).toEqual([[{ type: "text", text: "a" }], [{ type: "text", text: "b" }], [{ type: "text", text: "c" }]]);
    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: true, status: { state: "ready" } });
  });

  test("a legacy SSE server's calls refreshing at once on its message endpoint keep it signed in", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth" }, legacySse: true });
    const { id } = models.mcpServers.create({ name: "legacy", url: fake.url, transport: "sse", authKind: "oauth" });
    await signIn(models, fake, id);
    await models.mcpServers.get(id).listTools();

    fake.expireAccessTokens();
    const results = await Promise.all(["a", "b", "c"].map(text => models.mcpServers.get(id).callTool("echo", { text })));

    expect(results.map(result => result.content)).toEqual([[{ type: "text", text: "a" }], [{ type: "text", text: "b" }], [{ type: "text", text: "c" }]]);
    expect(fake.tokenRequests).toEqual(["authorization_code", "refresh_token"]);
    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: true, status: { state: "ready" } });
  });

  test("starting a sign-in at a server that needs none leaves no MCP session open on it", async () => {
    const { models } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "open", url: fake.url, authKind: "oauth" });

    await models.mcpServers.get(id).startSignIn("http://localhost/oauth/mcp/callback").catch(() => undefined);

    expect(fake.sessionsOpened).toBe(1);
    expect(fake.openSessions).toBe(0);
  });

  test("a sign-in from another origin registers a client that replaces the signed-in one only once it completes", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);
    await models.mcpServers.get(id).listTools();

    const elsewhere = await models.mcpServers.get(id).startSignIn("https://reins.invalid/oauth/mcp/callback");
    fake.expireAccessTokens();
    expect(await models.mcpServers.get(id).callTool("echo", { text: "kept" })).toEqual({ content: [{ type: "text", text: "kept" }] });

    const callback = await fake.authorize(elsewhere.authorizationUrl);
    await models.mcpServers.finishSignIn({ state: callback.searchParams.get("state"), code: callback.searchParams.get("code") });
    fake.expireAccessTokens();
    expect(await models.mcpServers.get(id).callTool("echo", { text: "moved" })).toEqual({ content: [{ type: "text", text: "moved" }] });
    expect(fake.registrations.size).toBe(2);
    expect(fake.tokenRequests).toEqual(["authorization_code", "refresh_token", "authorization_code", "refresh_token"]);
    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: true, status: { state: "ready" } });
  });

  test("a sign-in whose code exchange fails leaves the server signed in as it was", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);

    const again = await models.mcpServers.get(id).startSignIn("http://localhost/oauth/mcp/callback");
    const callback = await fake.authorize(again.authorizationUrl);
    const failure = await models.mcpServers.finishSignIn({ state: callback.searchParams.get("state"), code: "not-the-code" }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "McpSignInError" });
    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: true });
    expect(await models.mcpServers.get(id).callTool("echo", { text: "still" })).toEqual({ content: [{ type: "text", text: "still" }] });
  });

  test("tokens that no longer refresh (revoked) leave the server needing sign-in", async () => {
    const { models, messages } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);
    await models.mcpServers.get(id).listTools();

    fake.revokeTokens();
    const failure = await models.mcpServers.get(id).callTool("echo", { text: "x" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpServerUnavailableError);
    expect(failure).toMatchObject({ status: { state: "needs_sign_in" } });
    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: false, status: { state: "needs_sign_in" } });
    expect(messages.at(-1)).toMatchObject({ type: "mcp_server_updated", server: { id, status: { state: "needs_sign_in" } } });
  });

  test("a server nobody uses has its old tokens refreshed in the background, and its new refresh token works", async () => {
    const { models } = observedState(backgroundRefresh);
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);

    await Bun.sleep(50);
    expect(fake.tokenRequests).toEqual(["authorization_code"]);

    ageTokens(id);
    await until(() => fake.tokenRequests.length === 2, "the background refresh");
    await Bun.sleep(50);
    expect(fake.tokenRequests).toEqual(["authorization_code", "refresh_token"]);

    fake.expireAccessTokens();
    expect(await models.mcpServers.get(id).callTool("echo", { text: "later" })).toEqual({ content: [{ type: "text", text: "later" }] });
    expect(fake.tokenRequests).toEqual(["authorization_code", "refresh_token", "refresh_token"]);
  });

  test("a background refresh the authorization server refuses (revoked) leaves the server needing sign-in, and says so", async () => {
    const { models, messages } = observedState(backgroundRefresh);
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);

    fake.revokeTokens();
    ageTokens(id);
    const before = messages.length;

    await until(() => messages.slice(before).some(message => message.type === "mcp_server_updated" && message.server.status.state === "needs_sign_in"), "the sign-out");
    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: false, status: { state: "needs_sign_in" } });
  });

  test("a disabled server's tokens are not refreshed", async () => {
    const { models } = observedState(backgroundRefresh);
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);
    await models.mcpServers.get(id).update({ enabled: false });

    ageTokens(id);
    await Bun.sleep(50);

    expect(fake.tokenRequests).toEqual(["authorization_code"]);
  });

  test("a call refreshing while a background refresh is under way waits for it, so a rotated refresh token is used once", async () => {
    const { models } = observedState(backgroundRefresh);
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);
    await models.mcpServers.get(id).listTools();

    const release = fake.holdRefreshes();
    ageTokens(id);
    await until(() => fake.tokenRequests.length === 2, "the background refresh");
    fake.expireAccessTokens();
    const call = models.mcpServers.get(id).callTool("echo", { text: "after" });
    await Bun.sleep(50);
    release();

    expect(await call).toEqual({ content: [{ type: "text", text: "after" }] });
    expect(fake.tokenRequests).toEqual(["authorization_code", "refresh_token"]);
    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: true, status: { state: "ready" } });
  });

  test("signing out while a call's refresh is under way leaves the server signed out", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);
    await models.mcpServers.get(id).listTools();

    const release = fake.holdRefreshes();
    fake.expireAccessTokens();
    const call = models.mcpServers.get(id).callTool("echo", { text: "x" }).catch((error: unknown) => error);
    await until(() => fake.tokenRequests.length === 2, "the call's refresh");
    await models.mcpServers.get(id).signOut();
    release();
    await call;
    await Bun.sleep(50);

    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: false, status: { state: "needs_sign_in" } });
  });

  test("a sign-in that completes while a background refresh is under way keeps the sign-in's tokens", async () => {
    const { models } = observedState(backgroundRefresh);
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const { id } = models.mcpServers.create({ name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(models, fake, id);

    const release = fake.holdRefreshes();
    ageTokens(id);
    await until(() => fake.tokenRequests.length === 2, "the background refresh");
    // From another origin: a new client, which cannot refresh the old client's tokens.
    const elsewhere = await models.mcpServers.get(id).startSignIn("https://reins.invalid/oauth/mcp/callback");
    const callback = await fake.authorize(elsewhere.authorizationUrl);
    await models.mcpServers.finishSignIn({ state: callback.searchParams.get("state"), code: callback.searchParams.get("code") });
    release();
    await Bun.sleep(50);

    fake.expireAccessTokens();
    expect(await models.mcpServers.get(id).callTool("echo", { text: "new" })).toEqual({ content: [{ type: "text", text: "new" }] });
    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: true, status: { state: "ready" } });
  });

  test("a sign-in asks for offline_access when the authorization server offers it, so the access token can be refreshed", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth", offlineAccess: true, expiresIn: 1 } });
    const { id } = models.mcpServers.create({ name: "vercel", url: fake.url, authKind: "oauth" });

    const { authorizationUrl } = await models.mcpServers.get(id).startSignIn("http://localhost/oauth/mcp/callback");
    expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("tools offline_access");
    const callback = await fake.authorize(authorizationUrl);
    await models.mcpServers.finishSignIn({ state: callback.searchParams.get("state"), code: callback.searchParams.get("code") });
    await Bun.sleep(1100);
    fake.expireAccessTokens();

    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: true });
    expect(await models.mcpServers.get(id).callTool("echo", { text: "later" })).toEqual({ content: [{ type: "text", text: "later" }] });
  });

  test("a scope set on the server is asked for as it is", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth", offlineAccess: true } });
    const { id } = models.mcpServers.create({ name: "vercel", url: fake.url, authKind: "oauth", oauthScope: "tools" });

    const { authorizationUrl } = await models.mcpServers.get(id).startSignIn("http://localhost/oauth/mcp/callback");

    expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("tools");
  });

  test("a server whose access token expires without a refresh token needs sign-in from then", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ auth: { kind: "oauth", offlineAccess: true, expiresIn: 1 } });
    const { id } = models.mcpServers.create({ name: "vercel", url: fake.url, authKind: "oauth", oauthScope: "tools" });
    await signIn(models, fake, id);
    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: true, status: { state: "ready" } });

    await until(() => models.mcpServers.get(id).view().status.state === "needs_sign_in", "the expiry");

    expect(models.mcpServers.get(id).view()).toMatchObject({ signedIn: false, status: { state: "needs_sign_in" } });
    const failure = await models.mcpServers.get(id).listTools().catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: { state: "needs_sign_in" } });
  });

  test("a caller that stops waiting for the tool list leaves the listing to finish for the next caller", async () => {
    const { models } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "slow", url: fake.url, authKind: "none" });
    const release = fake.holdToolLists();
    const controller = new AbortController();

    const gaveUp = models.mcpServers.get(id).listTools({ signal: controller.signal }).catch((error: unknown) => error);
    await until(() => fake.toolListings === 1, "the server to receive the listing");
    controller.abort(new Error("search deadline"));
    expect(await gaveUp).toMatchObject({ message: "search deadline" });
    release();
    const tools = await models.mcpServers.get(id).listTools();

    expect(tools.map(tool => tool.name)).toEqual(["echo"]);
    expect(fake.toolListings).toBe(1);
    expect(models.mcpServers.get(id).view().status).toEqual({ state: "ready" });
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

    const timedOut = await models.mcpServers.get(id).callTool("wait", {}, { timeoutMs: 50 }).catch((error: unknown) => error);
    const controller = new AbortController();
    const aborted = models.mcpServers.get(id).callTool("wait", {}, { signal: controller.signal }).catch((error: unknown) => error);
    await Bun.sleep(20);
    controller.abort(new Error("user stopped"));

    expect(timedOut).toBeInstanceOf(McpError);
    expect(timedOut).toMatchObject({ code: ErrorCode.RequestTimeout });
    expect(await aborted).toMatchObject({ message: expect.stringContaining("user stopped") });
    await until(() => cancelled.length === 2, "the server to see both cancellations");
    expect(await models.mcpServers.get(id).callTool("echo", { text: "still here" })).toEqual({ content: [{ type: "text", text: "still here" }] });
    expect(fake.sessionsOpened).toBe(1);
  });

  test("an idle connection is closed, and the next call opens another", async () => {
    const { models } = observedState({ mcp: { idleMs: 30 } });
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });
    await models.mcpServers.get(id).listTools();

    await Bun.sleep(100);
    await models.mcpServers.get(id).listTools();

    expect(fake.sessionsOpened).toBe(2);
  });

  test("a legacy SSE server is reached through the SSE transport; changed to streamable HTTP, it fails with a hint", async () => {
    const { models } = observedState();
    const fake = await fakeServer({ legacySse: true });
    const { id } = models.mcpServers.create({ name: "legacy", url: fake.url, transport: "sse", authKind: "none" });

    expect((await models.mcpServers.get(id).listTools()).map(tool => tool.name)).toEqual(["echo"]);
    expect(await models.mcpServers.get(id).callTool("echo", { text: "old" })).toEqual({ content: [{ type: "text", text: "old" }] });

    await models.mcpServers.get(id).update({ transport: "http" });
    const failure = await models.mcpServers.get(id).listTools().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpServerUnavailableError);
    expect(models.mcpServers.get(id).view()).toMatchObject({
      transport: "http",
      status: { state: "error", message: "The server answered HTTP 405. If this is a legacy HTTP+SSE server, set its transport to SSE." },
    });
  });

  test("a stopped app's connections are closed and it connects nothing more", async () => {
    const { state, models } = observedState();
    const fake = await fakeServer();
    const { id } = models.mcpServers.create({ name: "local", url: fake.url, authKind: "none" });
    await models.mcpServers.get(id).listTools();

    await state.mcp.close();

    expect(await models.mcpServers.get(id).listTools().catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(fake.sessionsOpened).toBe(1);
  });
});
