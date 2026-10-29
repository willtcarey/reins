import { afterEach, describe, expect, test } from "bun:test";
import { runScript } from "../../tools/execute.js";
import { getDb } from "../../app-globals.js";
import type { ApiContext } from "../../scripting/define-function.js";
import { Models } from "../../models/models.js";
import { createAppState } from "../helpers/app-state.js";
import { echoTool, startFakeMcpServer, type FakeMcpServer } from "../helpers/fake-mcp-server.js";
import { useTestDb } from "../helpers/test-db.js";

const fakes: FakeMcpServer[] = [];

afterEach(async () => {
  await Promise.all(fakes.splice(0).map(fake => fake.stop()));
});

/** Runs `code` as an `execute` script of a session; its result or its error. */
function scripting() {
  const state = createAppState();
  const models = new Models(state);
  const ctx: ApiContext = { projectId: 1, sessionId: "caller", taskId: null, broadcast: models.broadcast, sourceId: 0, nodes: state.nodes, models };
  return (code: string) => runScript(ctx, code);
}

describe("api.mcp", () => {
  useTestDb();

  test("an agent adds a header server with its secret, connects to it, and reads it back without the secret", async () => {
    const fake = await startFakeMcpServer({ auth: { kind: "header", name: "X-Api-Key", value: "agent-s3cret" } });
    fakes.push(fake);
    const script = scripting();

    const result = await script(`
      await api.mcp.add({ name: "keyed", description: "Test tools", url: ${JSON.stringify(fake.url)}, authKind: "header", headerName: "X-Api-Key", headerValue: "agent-s3cret" });
      const tested = await api.mcp.test("keyed");
      return { tested, listed: await api.mcp.list() };
    `);

    if (!result.ok) throw new Error(result.error);
    const tested = {
      id: expect.any(Number), name: "keyed", description: "Test tools", url: fake.url, authKind: "header", headerName: "X-Api-Key",
      hasHeaderValue: true, oauthClientId: null, hasClientSecret: false, oauthScope: null, enabled: true, signedIn: false,
      status: { state: "connected" }, toolCount: 1,
    };
    expect(JSON.parse(result.text)).toEqual({ tested, listed: [tested] });
    expect(result.text).not.toContain("agent-s3cret");
    expect(getDb().query<{ value: string }, []>("SELECT value FROM mcp_server_secrets").get()!.value).not.toContain("agent-s3cret");
  });

  test("an agent starts an OAuth sign-in for the user, and completes it from the address of a callback page that did not load", async () => {
    const fake = await startFakeMcpServer({ auth: { kind: "oauth" } });
    fakes.push(fake);
    const script = scripting();
    await script(`await api.mcp.add({ name: "executor", url: ${JSON.stringify(fake.url)}, authKind: "oauth" })`);

    const started = await script(`return await api.mcp.signIn("executor", "https://reins.invalid:8443/settings")`);
    if (!started.ok) throw new Error(started.error);
    const { authorizationUrl, callbackUrl } = JSON.parse(started.text);
    // The user approves; their browser cannot open Reins there, so they copy the address it was sent to.
    const landed = await fake.authorize(authorizationUrl);
    const finished = await script(`return await api.mcp.finishSignIn(${JSON.stringify(landed.href)})`);
    const again = await script(`return (await api.mcp.signIn("executor")).callbackUrl`);

    expect(callbackUrl).toBe("https://reins.invalid:8443/oauth/mcp/callback");
    expect(landed.origin + landed.pathname).toBe(callbackUrl);
    if (!finished.ok) throw new Error(finished.error);
    expect(JSON.parse(finished.text)).toMatchObject({ name: "executor", signedIn: true });
    expect(fake.tokenRequests).toEqual(["authorization_code"]);
    expect(again).toEqual({ ok: true, text: callbackUrl });
  });

  test("an agent changes, disables and removes a server by name; an OAuth server it adds needs sign-in", async () => {
    const script = scripting();

    const result = await script(`
      const added = await api.mcp.add({ name: "executor", url: "https://executor.example.com/mcp", authKind: "oauth" });
      const changed = await api.mcp.update("executor", { description: "Brand New Box tools", enabled: false });
      await api.mcp.remove(added.id);
      return { added: added.status, changed: [changed.description, changed.status], left: await api.mcp.list() };
    `);

    if (!result.ok) throw new Error(result.error);
    expect(JSON.parse(result.text)).toEqual({ added: { state: "needs_sign_in" }, changed: ["Brand New Box tools", { state: "disabled" }], left: [] });
  });

  test("an agent finds a server's tools by a query and calls one", async () => {
    const fake = await startFakeMcpServer({
      tools: [echoTool, { name: "list_projects", description: "Lists the team's projects", inputSchema: { type: "object" } }],
    });
    fakes.push(fake);
    const script = scripting();
    await script(`await api.mcp.add({ name: "tools", url: ${JSON.stringify(fake.url)}, authKind: "none" })`);

    const result = await script(`
      const all = await api.mcp.tools("tools");
      const found = await api.mcp.tools("tools", "PROJECTS");
      return { all: all.map(tool => tool.name), found, echoed: await api.mcp.call("tools", "echo", { text: "hello" }) };
    `);

    if (!result.ok) throw new Error(result.error);
    expect(JSON.parse(result.text)).toEqual({
      all: ["echo", "list_projects"],
      found: [{ name: "list_projects", description: "Lists the team's projects", inputSchema: { type: "object" } }],
      echoed: { content: [{ type: "text", text: "hello" }] },
    });
  });

  test("a tool's own failure is its result; a server that cannot be used fails the script with why", async () => {
    const fake = await startFakeMcpServer({
      tools: [{ name: "deploy", inputSchema: { type: "object" }, run: () => ({ content: [{ type: "text", text: "No such project" }], isError: true }) }],
    });
    fakes.push(fake);
    const script = scripting();
    await script(`
      await api.mcp.add({ name: "tools", url: ${JSON.stringify(fake.url)}, authKind: "none" });
      await api.mcp.add({ name: "vercel", url: "https://mcp.vercel.invalid", authKind: "oauth" });
    `);

    const failed = await script(`return await api.mcp.call("tools", "deploy", { project: "x" })`);
    const signedOut = await script(`return await api.mcp.call("vercel", "list_projects")`);

    expect(failed).toEqual({ ok: true, text: JSON.stringify({ content: [{ type: "text", text: "No such project" }], isError: true }, null, 2) });
    expect(signedOut).toMatchObject({ ok: false, error: expect.stringContaining("MCP server vercel needs sign-in") });
  });

  test("an unknown server or an invalid one fails the script with why", async () => {
    const script = scripting();
    await script(`await api.mcp.add({ name: "slack", url: "https://mcp.slack.com/mcp", authKind: "oauth" })`);

    const unknown = await script(`return await api.mcp.get("executor")`);
    const invalid = await script(`return await api.mcp.add({ name: "Bad Name", url: "https://example.com/mcp", authKind: "none" })`);

    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("MCP server not found: executor (the servers: slack)") });
    expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining("Name must start with a lowercase letter") });
  });
});
