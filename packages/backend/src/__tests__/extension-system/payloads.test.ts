import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Type } from "@sinclair/typebox";
import type { ServerSdk } from "@reins/sdk/server";
import { runScript } from "../../tools/execute.js";
import { buildRouter } from "../../routes/index.js";
import { getDb } from "../../app-globals.js";
import { createAppState } from "../helpers/app-state.js";
import { connectLoopbackNode, loopbackLink, stopLoopbackNode } from "../helpers/loopback-node.js";
import { makeRequest } from "../helpers/request.js";
import { scriptContext } from "../helpers/script-context.js";
import { useTestDb } from "../helpers/test-db.js";

const router = buildRouter();
const SECRET = "sk-live-4f1c9e";
const METHODS = ["log", "info", "warn", "error", "debug"] as const;

/** Everything written to the console while the server logs at its most verbose. */
function captureConsole() {
  const written: string[] = [];
  const saved = METHODS.map(method => [method, console[method]] as const);
  const env = { NODE_ENV: process.env.NODE_ENV, REINS_LOG_LEVEL: process.env.REINS_LOG_LEVEL };
  process.env.NODE_ENV = "development";
  process.env.REINS_LOG_LEVEL = "debug";
  for (const method of METHODS) {
    console[method] = (...args: unknown[]) => {
      written.push(args.map(arg => arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === "string" ? arg : Bun.inspect(arg)).join(" "));
    };
  }
  return {
    written,
    restore() {
      for (const [method, original] of saved) console[method] = original;
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

describe("payloads stay out of the server's log", () => {
  useTestDb();
  let reins: ServerSdk;
  let dir: string;
  let output: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reins-payloads-"));
    output = captureConsole();
  });
  afterEach(() => {
    output.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an extension's HTTP bodies, its tools' arguments and results, and files it writes and commands' environments on a node are not logged, also when a handler fails", async () => {
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('mini', 'Mac mini')");
    const state = createAppState(undefined, {
      extensions: [{
        name: "vault",
        register: sdk => {
          reins = sdk;
          const tools = sdk.tools.register({
            title: "Vault",
            search: async () => [],
            call: async (_id, args) => ({ content: [{ type: "text", text: `stored ${String(args.value)}` }] }),
          });
          const api = sdk.http.handle(
            { store: { input: Type.Object({ value: Type.String() }), output: Type.Boolean() }, fail: { input: Type.Object({ value: Type.String() }) } },
            { store: () => true, fail: () => { throw new Error("could not store it"); } },
          );
          return async () => { await tools(); await api(); };
        },
      }],
    });
    connectLoopbackNode(state, { nodeId: "mini" });
    await loopbackLink(state, "mini").ready();

    const stored = await router.handle(makeRequest("POST", "/api/extensions/vault/store", { value: SECRET }), state);
    const failed = await router.handle(makeRequest("POST", "/api/extensions/vault/fail", { value: SECRET }), state);
    const called = await runScript(scriptContext(state, { sessionId: "caller" }), `return (await reins.tools.call("vault__keep", { value: ${JSON.stringify(SECRET)} })).content[0].text`);
    await reins.nodes.writeFile("mini", join(dir, "notes.txt"), `KEY=${SECRET}\n`);
    const appended = await reins.nodes.run("mini", `printf '%s\\n' "KEY=$KEY" >> .env; cat .env`, { cwd: dir, env: { KEY: SECRET } });
    await stopLoopbackNode(state, "mini");
    await state.nodes.close();

    expect(stored!.status).toBe(200);
    expect(failed!.status).toBe(500);
    expect(called).toEqual({ ok: true, text: `stored ${SECRET}` });
    expect(appended.output).toBe(`KEY=${SECRET}\n`);
    expect(output.written.some(line => line.includes("could not store it"))).toBe(true);
    expect(output.written.filter(line => line.includes(SECRET))).toEqual([]);
  });
});
