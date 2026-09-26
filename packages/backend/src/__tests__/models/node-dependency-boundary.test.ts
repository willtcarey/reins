import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const source = (path: string) => Bun.file(new URL(path, root)).text();

test("node implementation cannot import server state, DB, session or source tables", async () => {
  const nodeDir = new URL("../../../../node/src/", import.meta.url);
  const files = (await readdir(nodeDir, { recursive: true })).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  for (const file of files) {
    const text = await Bun.file(new URL(file, nodeDir)).text();
    expect(text).not.toMatch(/from\s+["'][^"']*(?:backend|server-state|session-store|node-store|\/db\.)/);
  }
  const [handler, dispatcher, node] = await Promise.all([
    source("handler.ts"), source("models/node-command-dispatcher.ts"), source("runtimes/internal-node.ts"),
  ]);
  expect(handler).not.toContain("new SessionManager");
  expect(dispatcher).not.toContain("internal-node-adapter");
  expect(node).toContain('from "@reins/node/node"');
});
