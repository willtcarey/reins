import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNodeIdentity, readNodeConfig } from "@reins/cli/node/config";
import { pairNode } from "@reins/cli/node/pair";
import { buildRouter } from "../../routes/index.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { connectLoopbackNode, loopbackLink, stopLoopbackNode } from "../helpers/loopback-node.js";

useTestDb();

const SERVER_URL = "http://reins.example.test:7777";
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };

test("a node paired by the CLI with a code from the settings route authenticates its connection, and revoking it closes the link and refuses the next dial", async () => {
  const state = createServerState();
  const router = buildRouter();
  const handle = async (request: Request) => (await router.handle(request, state))!;
  const call = async (method: string, path: string, body?: unknown) => (await handle(makeRequest(method, path, body))).json();
  const home = mkdtempSync(join(tmpdir(), "reins-node-home-"));
  let dialed: string | undefined;
  try {
    const { code } = await call("POST", "/api/nodes/pairing-codes", { name: "Laptop" });
    // The CLI reaches the same in-process server.
    const paired = await pairNode({ home, serverUrl: SERVER_URL, code, hostname: "laptop-host", fetch: (input, init) => handle(new Request(input, init)) });
    expect(paired).toMatchObject({ status: "paired", name: "Laptop" });
    const config = (await readNodeConfig(home))!;
    const identity = await loadNodeIdentity(config);
    expect(identity.origin).toBe(SERVER_URL);
    const { nodeId } = config;
    dialed = nodeId;

    connectLoopbackNode(state, { nodeId, identity, authenticate: { origin: new URL(SERVER_URL).origin } });
    await loopbackLink(state, nodeId).ready();
    expect(await call("GET", "/api/nodes")).toContainEqual(expect.objectContaining({ id: nodeId, name: "Laptop", connected: true, paired: true, hostname: "laptop-host", revokedAt: null }));

    expect(await call("POST", `/api/nodes/${nodeId}/revoke`)).toMatchObject({ id: nodeId, connected: false, revokedAt: expect.any(String) });
    await until(() => !state.nodes.get(nodeId).connected);
    const link = loopbackLink(state, nodeId);
    link.redial();
    await expect(link.ready()).rejects.toThrow();
    expect(await call("GET", "/api/nodes")).toContainEqual(expect.objectContaining({ id: nodeId, connected: false }));
  } finally {
    if (dialed) await stopLoopbackNode(state, dialed);
    await state.nodes.close();
    rmSync(home, { recursive: true, force: true });
  }
});
