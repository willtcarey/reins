import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerSdk } from "@reins/sdk/server";
import { runScript } from "../../../tools/execute.js";
import { getDb } from "../../../app-globals.js";
import { upsertSource } from "../../../node-store.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { connectLoopbackNode, loopbackLink, SEEDED_NODE_ID, stopLoopbackNode } from "../../helpers/loopback-node.js";
import { fakeStdioServer } from "../../helpers/fake-stdio-mcp-server.js";
import { testMcp } from "../../helpers/mcp-extension.js";
import { callingSession, scriptContext } from "../../helpers/script-context.js";
import { extensionDb, useTestDb } from "../../helpers/test-db.js";
import { makeRequest } from "../../helpers/request.js";
import { buildRouter } from "../../../routes/index.js";
import type { McpOptions } from "../../../extensions/mcp/index.js";

setDefaultTimeout(20_000);

const LAPTOP = "laptop";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (await condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

interface Whoami { pid: number; cwd: string; args: string[]; token: string | null }

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups = [];
});

/** An app with the MCP extension and two nodes (the seeded one and `laptop`), and three sessions, each in a checkout
 * of its own: `a` and `b` on the seeded node, `laptop` on the laptop. `reins` is another extension's SDK, which calls
 * tools with no session. `log` is where the fake server records each start. */
async function app(options: McpOptions = {}) {
  getDb().exec(`INSERT INTO nodes (id, name) VALUES ('${LAPTOP}', 'Laptop')`);
  const mcp = testMcp(options);
  let reins: ServerSdk | undefined;
  const state: TestAppState = createAppState(undefined, {
    extensions: [mcp.registration, { name: "caller", register: sdk => { reins = sdk; return () => {}; } }],
  });
  for (const nodeId of [SEEDED_NODE_ID, LAPTOP]) connectLoopbackNode(state, { nodeId });
  cleanups.push(async () => {
    await state.extensions.dispose();
    for (const nodeId of [SEEDED_NODE_ID, LAPTOP]) await stopLoopbackNode(state, nodeId);
    await state.nodes.close();
  });
  await Promise.all([SEEDED_NODE_ID, LAPTOP].map(nodeId => loopbackLink(state, nodeId).ready()));
  await state.extensions.loaded;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reins-stdio-mcp-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const checkouts = { a: join(dir, "a"), b: join(dir, "b"), laptop: join(dir, "laptop") };
  for (const checkout of Object.values(checkouts)) mkdirSync(join(checkout, "web"), { recursive: true });
  const sessions = {
    a: callingSession({ sessionId: "a", sourceId: upsertSource(SEEDED_NODE_ID, checkouts.a).id }),
    b: callingSession({ sessionId: "b", sourceId: upsertSource(SEEDED_NODE_ID, checkouts.b).id }),
    laptop: callingSession({ sessionId: "on-laptop", sourceId: upsertSource(LAPTOP, checkouts.laptop).id }),
  };
  /** Runs `code` as a script of `session`; its result, or throws its error. */
  const script = async (session: string, code: string): Promise<string> => {
    const result = await runScript(scriptContext(state, { sessionId: session }), code);
    if (!result.ok) throw new Error(result.error);
    return result.text;
  };
  const call = async (session: string, tool: string, args: object = {}) => {
    const result: { content: Array<{ text: string }> } = JSON.parse(await script(session, `return await reins.tools.call(${JSON.stringify(`mcp__fake__${tool}`)}, ${JSON.stringify(args)})`));
    return result.content[0]!.text;
  };
  const whoami = async (session: string): Promise<Whoami> => JSON.parse(await call(session, "whoami"));
  const log = join(dir, "starts.log");
  const starts = () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  /** The nodes of the server's processes running now, by session, from the records the host keeps for MCP. */
  const running = () => Object.fromEntries(getDb().query<{ key: string; node_id: string }, []>(
    "SELECT key, node_id FROM processes WHERE owner = 'extension:mcp' AND ended_json IS NULL ORDER BY key",
  ).all().map(row => [row.key, row.node_id]));
  return { state, servers: mcp.servers, reins: () => reins!, sessions, checkouts, script, call, whoami, log, starts, running };
}

describe("stdio MCP servers", () => {
  useTestDb();

  test("a session's call starts the server on its node, in its checkout, and answers the tool's result", async () => {
    const { servers, sessions, checkouts, call, whoami, running } = await app();
    await servers.create({ name: "fake", ...fakeStdioServer });

    const echoed = await call(sessions.a, "echo", { text: "hello" });
    const where = await whoami(sessions.a);

    expect(echoed).toBe("hello");
    expect(where.cwd).toBe(checkouts.a);
    expect(running()).toEqual({ "mcp:fake:a": SEEDED_NODE_ID });
    expect(await servers.find("fake").view()).toEqual({
      id: expect.any(Number), name: "fake", instructions: "", enabled: true, transport: "stdio", command: process.execPath, args: fakeStdioServer.args,
      cwd: null, envNames: [], status: { state: "ready" }, createdAt: expect.any(String), updatedAt: expect.any(String),
    });
  });

  test("each session gets a process of its own, on its own node, and a relative cwd is inside its checkout", async () => {
    const { servers, sessions, checkouts, whoami, running } = await app();
    await servers.create({ name: "fake", ...fakeStdioServer, cwd: "web" });

    const [a, b, laptop] = await Promise.all([whoami(sessions.a), whoami(sessions.b), whoami(sessions.laptop)]);

    expect(new Set([a.pid, b.pid, laptop.pid]).size).toBe(3);
    expect([a.cwd, b.cwd, laptop.cwd]).toEqual([join(checkouts.a, "web"), join(checkouts.b, "web"), join(checkouts.laptop, "web")]);
    expect(running()).toEqual({ "mcp:fake:a": SEEDED_NODE_ID, "mcp:fake:b": SEEDED_NODE_ID, "mcp:fake:on-laptop": LAPTOP });
  });

  test("a session's concurrent first calls share one start", async () => {
    const { servers, sessions, whoami, log, starts } = await app();
    await servers.create({ name: "fake", ...fakeStdioServer, env: { FAKE_MCP_LOG: log } });

    const pids = new Set((await Promise.all([1, 2, 3, 4].map(() => whoami(sessions.a)))).map(where => where.pid));

    expect(pids.size).toBe(1);
    expect(starts()).toBe(1);
  });

  test("an idle process is stopped; searches answer from the tool list meanwhile, in other sessions too; the next call starts it again", async () => {
    const { servers, sessions, script, whoami, log, starts } = await app({ idleMs: 100 });
    await servers.create({ name: "fake", ...fakeStdioServer, env: { FAKE_MCP_LOG: log } });
    const first = await whoami(sessions.a);
    await until(() => !alive(first.pid), "the idle server to stop");

    const found = await script(sessions.a, `return await reins.tools.search("echo", { filters: { server: "fake" } })`);
    const elsewhere = await script(sessions.laptop, `return await reins.tools.search("crash")`);

    expect(found).toContain("mcp__fake__echo(");
    expect(elsewhere).toContain("mcp__fake__crash(");
    expect(starts()).toBe(1);
    const again = await whoami(sessions.a);
    expect(again.pid).not.toBe(first.pid);
    expect(starts()).toBe(2);
  });

  test("a crash fails the call with the end of its stderr, shows in the server's status, and the next call starts it again", async () => {
    const { servers, sessions, call, whoami } = await app();
    await servers.create({ name: "fake", ...fakeStdioServer });
    const before = await whoami(sessions.a);

    const crashed = call(sessions.a, "crash");

    await expect(crashed).rejects.toThrow(/MCP server fake is unavailable: .*exited with code 3.*fatal: the fake server crashed on purpose/s);
    expect((await servers.find("fake").view()).status).toEqual({ state: "error", message: expect.stringContaining("fatal: the fake server crashed on purpose") });
    const after = await whoami(sessions.a);
    expect(after.pid).not.toBe(before.pid);
    expect((await servers.find("fake").view()).status).toEqual({ state: "ready" });
  });

  test("a command the node does not have fails with why", async () => {
    const { servers, sessions, call } = await app();
    await servers.create({ name: "fake", command: "reins-no-such-mcp-server", args: ["--stdio"] });

    await expect(call(sessions.a, "echo")).rejects.toThrow(/MCP server fake is unavailable: .*Program not found: reins-no-such-mcp-server/);
  });

  test("changing its arguments stops every session's process, and the next call starts it as changed", async () => {
    const { servers, sessions, whoami } = await app();
    await servers.create({ name: "fake", ...fakeStdioServer });
    const [a, laptop] = await Promise.all([whoami(sessions.a), whoami(sessions.laptop)]);

    await servers.find("fake").update({ args: [...fakeStdioServer.args, "--v2"] });

    expect([alive(a.pid), alive(laptop.pid)]).toEqual([false, false]);
    expect((await whoami(sessions.a)).args).toEqual(["--v2"]);
  });

  test("disabling or removing it stops every session's process", async () => {
    const { servers, sessions, whoami, call, running } = await app();
    await servers.create({ name: "fake", ...fakeStdioServer });
    const [a, b] = await Promise.all([whoami(sessions.a), whoami(sessions.b)]);

    await servers.find("fake").update({ enabled: false });

    expect([alive(a.pid), alive(b.pid)]).toEqual([false, false]);
    await expect(call(sessions.a, "echo")).rejects.toThrow("MCP server fake is disabled: only the user can turn it on, with /mcp");
    await servers.find("fake").update({ enabled: true });
    const again = await whoami(sessions.laptop);
    await servers.find("fake").remove();
    expect(alive(again.pid)).toBe(false);
    expect(running()).toEqual({});
  });

  test("a change gives only its server's kind's fields; changing the kind needs the new kind's and drops the old kind's secrets", async () => {
    const { servers } = await app();
    await servers.create({ name: "keyed", url: "https://example.com/mcp", authKind: "header", headerName: "X-Api-Key", headerValue: "k3y" });
    await servers.create({ name: "fake", ...fakeStdioServer });

    await expect(servers.find("fake").update({ url: "https://example.com/mcp" })).rejects.toThrow("url is a remote server's field; this is a stdio server (give transport to change its kind)");
    await expect(servers.find("keyed").update({ transport: "stdio" })).rejects.toThrow("A stdio server needs a command");
    const changed = await servers.find("keyed").update({ transport: "stdio", command: "npx", args: ["-y", "some-server"] });

    expect(changed).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "some-server"], envNames: [] });
    expect(changed).not.toHaveProperty("url");
    expect(getDb().query("SELECT key FROM extension_secrets WHERE extension = 'mcp'").all()).toEqual([]);
  });

  test("a call with no session is refused: a stdio server runs in the calling session's checkout", async () => {
    const { servers, reins, log, starts } = await app();
    await servers.create({ name: "fake", ...fakeStdioServer, env: { FAKE_MCP_LOG: log } });

    await expect(reins().tools.call("mcp__fake__echo", { text: "hi" })).rejects.toThrow("MCP server fake runs in the calling session's checkout, and this call has no session");
    expect(starts()).toBe(0);
  });

  test("an agent's mcp.test starts it afresh in its session; Settings lists the tools it listed, and cannot test it", async () => {
    const { state, servers, sessions, script, whoami } = await app();
    const router = buildRouter();
    const api = async (method: string, input: unknown) => {
      const res = (await router.handle(makeRequest("POST", `/api/extensions/mcp/${method}`, input), state))!;
      return { status: res.status, json: await res.json() };
    };
    const { id } = await servers.create({ name: "fake", ...fakeStdioServer });
    const before = await whoami(sessions.a);

    const tested = JSON.parse(await script(sessions.a, `return await reins.mcp.test("fake")`));
    const tools = await api("tools", { id });
    const untestable = await api("test", { id });

    expect(tested.toolCount).toBe(3);
    expect(alive(before.pid)).toBe(false);
    expect(tools.json.map((tool: { name: string }) => tool.name)).toEqual(["echo", "whoami", "crash"]);
    expect(untestable).toEqual({ status: 400, json: { error: "MCP server fake runs in the calling session's checkout, and this call has no session: use it from a session first (an agent can run reins.mcp.test)" } });
  });

  test("env values are kept as secrets: they reach the process, and are not in views, the databases or the logs", async () => {
    const logged = (["log", "info", "warn", "error", "debug"] as const).map(level => spyOn(console, level));
    cleanups.push(() => { for (const spy of logged) spy.mockRestore(); });
    const { servers, sessions, script, whoami } = await app();

    await script(sessions.a, `await reins.mcp.add({ name: "fake", command: ${JSON.stringify(fakeStdioServer.command)}, args: ${JSON.stringify(fakeStdioServer.args)}, env: { FAKE_TOKEN: "s3cret-token" } })`);
    const where = await whoami(sessions.a);
    await servers.find("fake").update({ env: { FAKE_TOKEN: null, OTHER: "an0ther-s3cret" } });
    const views = await script(sessions.a, `return [await reins.mcp.get("fake"), await reins.mcp.list()]`);

    expect(where.token).toBe("s3cret-token");
    expect((await whoami(sessions.a)).token).toBe("s3cret-token");
    expect(views).toContain(`"envNames": [\n      "FAKE_TOKEN",\n      "OTHER"\n    ]`);
    const everything = [
      views,
      JSON.stringify(await servers.list()),
      JSON.stringify(extensionDb("mcp").query("SELECT * FROM mcp_servers").all()),
      JSON.stringify(extensionDb("mcp").query("SELECT * FROM mcp_tool_lists").all()),
      JSON.stringify(getDb().query("SELECT * FROM extension_secrets").all()),
      JSON.stringify(getDb().query("SELECT * FROM processes").all()),
      JSON.stringify(logged.flatMap(spy => spy.mock.calls)),
    ].join("\n");
    expect(everything).not.toMatch(/s3cret-token|an0ther-s3cret/);
  });
});
