import { afterEach, describe, expect, test } from "bun:test";
import { extensionDb, useTestDb } from "../../helpers/test-db.js";
import { makeRequest } from "../../helpers/request.js";
import { getDb } from "../../../app-globals.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { startFakeMcpServer, type FakeMcpServer } from "../../helpers/fake-mcp-server.js";
import { buildRouter } from "../../../routes/index.js";
import type { McpServerView } from "../../../extensions/mcp/servers.js";

const router = buildRouter();
const fakes: FakeMcpServer[] = [];

async function fakeServer(options?: Parameters<typeof startFakeMcpServer>[0]): Promise<FakeMcpServer> {
  const fake = await startFakeMcpServer(options);
  fakes.push(fake);
  return fake;
}

afterEach(async () => {
  await Promise.all(fakes.splice(0).map(fake => fake.stop()));
});

/** Calls a method of the extension's HTTP API (`mcpApi`). */
async function call(state: TestAppState, method: string, input?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = (await router.handle(makeRequest("POST", `/api/extensions/mcp/${method}`, input), state))!;
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* HTML or empty */ }
  return { status: res.status, json, text };
}

/** Signs in as the user would: start, approve at the authorization server, land on the callback. */
async function signIn(state: TestAppState, fake: FakeMcpServer, serverId: number): Promise<{ status: number; text: string }> {
  const started = await call(state, "signIn", { id: serverId });
  expect(started.status).toBe(200);
  const callback = await fake.authorize(started.json.authorizationUrl);
  const page = (await router.handle(new Request(callback.href), state))!;
  return { status: page.status, text: await page.text() };
}

async function waitForStatus(state: TestAppState, serverId: number, wanted: string): Promise<McpServerView> {
  for (let i = 0; i < 200; i++) {
    const { json } = await call(state, "list");
    const servers: McpServerView[] = json;
    const server = servers.find(candidate => candidate.id === serverId)!;
    if (server.status.state === wanted) return server;
    await Bun.sleep(5);
  }
  throw new Error(`MCP server ${serverId} never reached ${wanted}`);
}

describe("MCP server routes", () => {
  useTestDb();

  test("adds a server without authentication, lists it and its tools", async () => {
    const state = createAppState();
    const fake = await fakeServer();

    const created = await call(state, "create", { name: "local", instructions: "A test server", url: fake.url, authKind: "none" });

    expect(created.status).toBe(200);
    expect(created.json).toEqual({
      id: expect.any(Number), name: "local", instructions: "A test server", url: fake.url, transport: "http",
      authKind: "none", headerName: null, hasHeaderValue: false, oauthClientId: null, hasClientSecret: false, oauthScope: null, enabled: true,
      signedIn: false, status: { state: "ready" }, createdAt: expect.any(String), updatedAt: expect.any(String),
    });

    const tools = await call(state, "tools", { id: created.json.id });
    expect(tools.json).toEqual([{
      name: "echo",
      description: "Answers its text",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    }]);
    const [listed]: McpServerView[] = (await call(state, "list")).json;
    expect(listed).toMatchObject({ name: "local", status: { state: "ready" } });
  });

  test("refuses an invalid name, URL or transport, a stdio server without a command or with a sign-in, and a name already taken", async () => {
    const state = createAppState();
    await call(state, "create", { name: "taken", url: "https://example.com/mcp", authKind: "none" });

    expect((await call(state, "create", { name: "Not Lowercase", url: "https://example.com/mcp", authKind: "none" })).status).toBe(400);
    expect((await call(state, "create", { name: "ftp", url: "ftp://example.com", authKind: "none" })).status).toBe(400);
    expect((await call(state, "create", { name: "stdio", url: "https://example.com/mcp", transport: "stdio", authKind: "none" })).status).toBe(400);
    expect((await call(state, "create", { name: "stdio", command: "npx", authKind: "oauth" })).status).toBe(400);
    expect((await call(state, "create", { name: "stdio", command: "npx", env: { "NOT-A-NAME": "x" } })).status).toBe(400);
    expect((await call(state, "create", { name: "taken", url: "https://example.com/other", authKind: "none" })).status).toBe(409);
    expect((await call(state, "list")).json.map((server: McpServerView) => server.name)).toEqual(["taken"]);
  });

  test("a static header authenticates the server, and its value is never returned or stored in clear", async () => {
    const state = createAppState();
    const fake = await fakeServer({ auth: { kind: "header", name: "X-Api-Key", value: "s3cret-header" } });

    const created = await call(state, "create", { name: "keyed", url: fake.url, authKind: "header", headerName: "X-Api-Key", headerValue: "s3cret-header" });
    const tested = await call(state, "test", { id: created.json.id });
    const renamed = await call(state, "update", { id: created.json.id, changes: { instructions: "Keyed" } });
    const listed = await call(state, "list");

    expect(tested.json).toMatchObject({ headerName: "X-Api-Key", hasHeaderValue: true, status: { state: "ready" } });
    for (const response of [created, tested, renamed, listed]) expect(response.text).not.toContain("s3cret-header");
    const stored = getDb().query<{ key: string; value: string }, []>("SELECT key, value FROM extension_secrets WHERE extension = 'mcp'").all();
    expect(stored.map(row => row.key)).toEqual([`servers/${created.json.id}/header_value`]);
    expect(stored[0]!.value).not.toContain("s3cret-header");
  });

  test("a wrong header value is an error saying the server refused it", async () => {
    const state = createAppState();
    const fake = await fakeServer({ auth: { kind: "header", name: "X-Api-Key", value: "right" } });
    const created = await call(state, "create", { name: "keyed", url: fake.url, authKind: "header", headerName: "X-Api-Key", headerValue: "wrong" });

    const tested = await call(state, "test", { id: created.json.id });
    const tools = await call(state, "tools", { id: created.json.id });

    expect(tested.json.status).toEqual({ state: "error", message: expect.stringContaining("HTTP 401") });
    expect(tools.status).toBe(502);
  });

  test("a server that is down is an error, and connects once it is back", async () => {
    const state = createAppState();
    const fake = await fakeServer();
    await fake.stop();
    fakes.splice(0);
    const created = await call(state, "create", { name: "down", url: fake.url, authKind: "none" });

    const tested = await call(state, "test", { id: created.json.id });
    const tools = await call(state, "tools", { id: created.json.id });

    expect(tested.json.status).toEqual({ state: "error", message: expect.any(String) });
    expect(tools.status).toBe(502);

    const back = await fakeServer();
    await call(state, "update", { id: created.json.id, changes: { url: back.url } });
    expect((await call(state, "test", { id: created.json.id })).json.status).toEqual({ state: "ready" });
  });

  test("an OAuth server needs sign-in until the user signs in: Reins registers itself, the callback exchanges the code and it connects", async () => {
    const state = createAppState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const created = await call(state, "create", { name: "executor", url: fake.url, authKind: "oauth" });
    expect(created.json).toMatchObject({ signedIn: false, status: { state: "needs_sign_in" } });
    expect((await call(state, "tools", { id: created.json.id })).status).toBe(409);

    const started = await call(state, "signIn", { id: created.json.id });
    const authorization = new URL(started.json.authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe(`${fake.origin}/authorize`);
    expect(authorization.searchParams.get("redirect_uri")).toBe("http://localhost/extensions/mcp/oauth/callback");
    expect(authorization.searchParams.get("resource")).toBe(fake.url);
    expect([...fake.registrations.values()].map(client => client.redirectUris)).toEqual([["http://localhost/extensions/mcp/oauth/callback"]]);

    const callback = await fake.authorize(started.json.authorizationUrl);
    const page = (await router.handle(new Request(callback.href), state))!;

    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain("Signed in to executor");
    expect(fake.tokenRequests).toEqual(["authorization_code"]);
    expect(await waitForStatus(state, created.json.id, "ready")).toMatchObject({ signedIn: true });
    expect((await call(state, "tools", { id: created.json.id })).json.map((tool: { name: string }) => tool.name)).toEqual(["echo"]);
  });

  test("a pre-registered client signs in with its ID and secret, without registering, and its secret stays hidden", async () => {
    const state = createAppState();
    const fake = await fakeServer({ auth: { kind: "oauth", preRegistered: { clientId: "reins-app", clientSecret: "client-s3cret" } } });
    const created = await call(state, "create", {
      name: "slack", url: fake.url, authKind: "oauth", oauthClientId: "reins-app", oauthClientSecret: "client-s3cret", oauthScope: "chat:write",
    });

    const started = await call(state, "signIn", { id: created.json.id });
    const authorization = new URL(started.json.authorizationUrl);
    const page = await signInFrom(state, fake, started.json.authorizationUrl);

    expect(authorization.searchParams.get("client_id")).toBe("reins-app");
    expect(authorization.searchParams.get("scope")).toBe("chat:write");
    expect(page.status).toBe(200);
    expect(fake.registrations.size).toBe(0);
    const view = await waitForStatus(state, created.json.id, "ready");
    expect(view).toMatchObject({ oauthClientId: "reins-app", hasClientSecret: true, signedIn: true });
    expect(JSON.stringify((await call(state, "list")).json)).not.toContain("client-s3cret");
  });

  test("a sign-in started before a reload completes on the next app", async () => {
    const before = createAppState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const created = await call(before, "create", { name: "executor", url: fake.url, authKind: "oauth" });
    const started = await call(before, "signIn", { id: created.json.id });
    await before.extensions.dispose();

    const after = createAppState();
    const page = await signInFrom(after, fake, started.json.authorizationUrl);

    expect(page.status).toBe(200);
    expect(await waitForStatus(after, created.json.id, "ready")).toMatchObject({ signedIn: true });
  });

  test("a callback for an unknown, replaced or refused sign-in signs nothing in", async () => {
    const state = createAppState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const created = await call(state, "create", { name: "executor", url: fake.url, authKind: "oauth" });
    const first = await call(state, "signIn", { id: created.json.id });
    const second = await call(state, "signIn", { id: created.json.id });

    const replaced = await signInFrom(state, fake, first.json.authorizationUrl);
    const refused = (await router.handle(new Request(`http://localhost/extensions/mcp/oauth/callback?error=access_denied&state=${new URL(second.json.authorizationUrl).searchParams.get("state")}`), state))!;

    expect(replaced.status).toBe(400);
    expect(replaced.text).toContain("unknown or was replaced");
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Signing in to executor was refused: access_denied");
    expect(fake.tokenRequests).toEqual([]);
    expect((await call(state, "list")).json[0]).toMatchObject({ signedIn: false, status: { state: "needs_sign_in" } });
  });

  test("a callback more than 15 minutes after its sign-in started signs nothing in", async () => {
    const state = createAppState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const created = await call(state, "create", { name: "executor", url: fake.url, authKind: "oauth" });
    const started = await call(state, "signIn", { id: created.json.id });
    extensionDb("mcp").query("UPDATE mcp_servers SET sign_in_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-16 minutes')").run();

    const page = await signInFrom(state, fake, started.json.authorizationUrl);

    expect(page.status).toBe(400);
    expect(page.text).toContain("This sign-in expired");
    expect(fake.tokenRequests).toEqual([]);
  });

  test("tokens are never returned, and signing out forgets them", async () => {
    const state = createAppState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const created = await call(state, "create", { name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(state, fake, created.json.id);
    const tokens = getDb().query<{ value: string }, []>("SELECT value FROM extension_secrets WHERE extension = 'mcp' AND key LIKE '%/tokens'").get()!;
    expect(tokens.value).not.toContain("access_token");

    const signedOut = await call(state, "signOut", { id: created.json.id });

    expect(signedOut.json).toMatchObject({ signedIn: false, status: { state: "needs_sign_in" } });
    expect((await call(state, "tools", { id: created.json.id })).status).toBe(409);
  });

  test("changing an OAuth server's URL signs it out; changing its instructions does not", async () => {
    const state = createAppState();
    const fake = await fakeServer({ auth: { kind: "oauth" } });
    const created = await call(state, "create", { name: "executor", url: fake.url, authKind: "oauth" });
    await signIn(state, fake, created.json.id);

    const instructed = await call(state, "update", { id: created.json.id, changes: { instructions: "Tools" } });
    const moved = await call(state, "update", { id: created.json.id, changes: { url: `${fake.url}?v=2` } });

    expect(instructed.json).toMatchObject({ instructions: "Tools", signedIn: true });
    expect(moved.json).toMatchObject({ signedIn: false, status: { state: "needs_sign_in" } });
  });

  test("a disabled server is not connected and lists no tools", async () => {
    const state = createAppState();
    const fake = await fakeServer();
    const created = await call(state, "create", { name: "local", url: fake.url, authKind: "none" });

    const disabled = await call(state, "update", { id: created.json.id, changes: { enabled: false } });
    const tools = await call(state, "tools", { id: created.json.id });

    expect(disabled.json).toMatchObject({ enabled: false, status: { state: "disabled" } });
    expect(tools.status).toBe(409);
    expect(fake.sessionsOpened).toBe(0);
  });

  test("removing a server removes its credentials", async () => {
    const state = createAppState();
    const created = await call(state, "create", { name: "keyed", url: "https://example.com/mcp", authKind: "header", headerName: "X-Api-Key", headerValue: "value" });

    const removed = await call(state, "remove", { id: created.json.id });

    expect(removed.status).toBe(204);
    expect((await call(state, "list")).json).toEqual([]);
    expect(getDb().query("SELECT * FROM extension_secrets").all()).toEqual([]);
    expect((await call(state, "remove", { id: created.json.id })).status).toBe(404);
  });
});

async function signInFrom(state: TestAppState, fake: FakeMcpServer, authorizationUrl: string): Promise<{ status: number; text: string }> {
  const callback = await fake.authorize(authorizationUrl);
  const page = (await router.handle(new Request(callback.href), state))!;
  return { status: page.status, text: await page.text() };
}
