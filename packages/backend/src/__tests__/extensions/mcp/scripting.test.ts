import { afterEach, describe, expect, test } from "bun:test";
import { runScript } from "../../../tools/execute.js";
import { createAppState } from "../../helpers/app-state.js";
import { startFakeMcpServer, type FakeMcpServer } from "../../helpers/fake-mcp-server.js";
import { useTestDb } from "../../helpers/test-db.js";
import { getDb } from "../../../app-globals.js";
import { scriptContext } from "../../helpers/script-context.js";

const fakes: FakeMcpServer[] = [];

afterEach(async () => {
  await Promise.all(fakes.splice(0).map(fake => fake.stop()));
});

/** Runs `code` as an `execute` script of a session; its result or its error. */
function scripting() {
  const state = createAppState();
  return (code: string) => runScript(scriptContext(state, { sessionId: "caller" }), code);
}

describe("reins.mcp", () => {
  useTestDb();

  test("an agent adds a header server with its secret, connects to it, and reads it back without the secret", async () => {
    const fake = await startFakeMcpServer({ auth: { kind: "header", name: "X-Api-Key", value: "agent-s3cret" } });
    fakes.push(fake);
    const script = scripting();

    const result = await script(`
      await reins.mcp.add({ name: "keyed", instructions: "Test tools", url: ${JSON.stringify(fake.url)}, authKind: "header", headerName: "X-Api-Key", headerValue: "agent-s3cret" });
      const tested = await reins.mcp.test("keyed");
      return { tested, listed: await reins.mcp.list() };
    `);

    if (!result.ok) throw new Error(result.error);
    const tested = {
      id: expect.any(Number), name: "keyed", instructions: "Test tools", url: fake.url, transport: "http",
      authKind: "header", headerName: "X-Api-Key",
      hasHeaderValue: true, oauthClientId: null, hasClientSecret: false, oauthScope: null, enabled: true, signedIn: false,
      status: { state: "ready" },
    };
    expect(JSON.parse(result.text)).toEqual({ tested: { server: tested, toolCount: 1 }, listed: [tested] });
    expect(result.text).not.toContain("agent-s3cret");
    expect(getDb().query<{ value: string }, []>("SELECT value FROM extension_secrets WHERE extension = 'mcp'").get()!.value).not.toContain("agent-s3cret");
  });

  test("an agent starts an OAuth sign-in for the user, and completes it from the address of a callback page that did not load", async () => {
    const fake = await startFakeMcpServer({ auth: { kind: "oauth" } });
    fakes.push(fake);
    const script = scripting();
    await script(`await reins.mcp.add({ name: "executor", url: ${JSON.stringify(fake.url)}, authKind: "oauth" })`);

    const started = await script(`return await reins.mcp.signIn("executor", "https://reins.invalid:8443/settings")`);
    if (!started.ok) throw new Error(started.error);
    const { authorizationUrl, callbackUrl } = JSON.parse(started.text);
    // The user approves; their browser cannot open Reins there, so they copy the address it was sent to.
    const landed = await fake.authorize(authorizationUrl);
    const finished = await script(`return await reins.mcp.finishSignIn(${JSON.stringify(landed.href)})`);
    const again = await script(`return (await reins.mcp.signIn("executor")).callbackUrl`);

    expect(callbackUrl).toBe("https://reins.invalid:8443/extensions/mcp/oauth/callback");
    expect(landed.origin + landed.pathname).toBe(callbackUrl);
    if (!finished.ok) throw new Error(finished.error);
    expect(JSON.parse(finished.text)).toMatchObject({ name: "executor", signedIn: true });
    expect(fake.tokenRequests).toEqual(["authorization_code"]);
    expect(again).toEqual({ ok: true, text: callbackUrl });
  });

  test("an agent changes, disables and removes a server by name; an OAuth server it adds needs sign-in", async () => {
    const script = scripting();

    const result = await script(`
      const added = await reins.mcp.add({ name: "executor", url: "https://executor.example.com/mcp", authKind: "oauth" });
      const changed = await reins.mcp.update("executor", { instructions: "Brand New Box tools.\\nUse its search tools first.", transport: "sse", enabled: false });
      await reins.mcp.remove(added.id);
      return { added: [added.transport, added.status], changed: [changed.instructions, changed.transport, changed.status], left: await reins.mcp.list() };
    `);

    if (!result.ok) throw new Error(result.error);
    expect(JSON.parse(result.text)).toEqual({
      added: ["http", { state: "needs_sign_in" }],
      changed: ["Brand New Box tools.\nUse its search tools first.", "sse", { state: "disabled" }],
      left: [],
    });
  });

  test("an unknown server or an invalid one fails the script with why", async () => {
    const script = scripting();
    await script(`await reins.mcp.add({ name: "slack", url: "https://mcp.slack.com/mcp", authKind: "oauth" })`);

    const unknown = await script(`return await reins.mcp.get("executor")`);
    const invalid = await script(`return await reins.mcp.add({ name: "Bad Name", url: "https://example.com/mcp", authKind: "none" })`);

    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("MCP server not found: executor (the servers: slack)") });
    expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining("Name must start with a lowercase letter") });
  });

  test("a script's server is checked as the HTTP API's is: its types, lengths and fields", async () => {
    const script = scripting();
    await script(`await reins.mcp.add({ name: "slack", url: "https://mcp.slack.com/mcp", authKind: "oauth" })`);

    const long = await script(`return await reins.mcp.add({ name: "long", url: "https://example.com/mcp", authKind: "none", instructions: "x".repeat(4001) })`);
    const wrongType = await script(`return await reins.mcp.update("slack", { enabled: "false" })`);
    const unknownField = await script(`return await reins.mcp.update("slack", { colour: "red" })`);

    expect(long).toEqual({ ok: false, error: "reins.mcp.add: server.instructions: Expected string length less or equal to 4000" });
    expect(wrongType).toEqual({ ok: false, error: "reins.mcp.update: changes.enabled: Expected boolean" });
    expect(unknownField).toEqual({ ok: false, error: "reins.mcp.update: changes.colour: Unexpected property" });
    const left = await script(`return (await reins.mcp.list()).map(server => [server.name, server.enabled])`);
    if (!left.ok) throw new Error(left.error);
    expect(JSON.parse(left.text)).toEqual([["slack", true]]);
  });
});
