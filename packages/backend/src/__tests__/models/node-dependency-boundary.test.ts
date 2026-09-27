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
  const [handler, dispatcher] = await Promise.all([source("handler.ts"), source("models/node-command-dispatcher.ts")]);
  expect(handler).not.toContain("new SessionManager");
  expect(dispatcher).not.toContain("internal-node-adapter");
});

test("server code never starts a node or opens node storage (only tests link an in-process node)", async () => {
  const files = (await readdir(root, { recursive: true }))
    .filter(name => name.endsWith(".ts") && !name.startsWith("__tests__/") && !name.endsWith(".test.ts"));
  expect(files).toContain("server-process.ts");
  for (const file of files) {
    const text = await source(file);
    // The node runtime, its connection and dialer, and value imports from node storage.
    expect({ file, imports: text.match(/from\s+["']@reins\/node\/(?:node|node-connection|local-link)["']|^import\s+(?!type\b)[^;]*from\s+["']@reins\/node\/storage["']/gm) }).toEqual({ file, imports: null });
    expect({ file, calls: text.match(/\b(?:startNode|getNodeDb|setNodeDb|createLoopbackPair)\s*\(/g) }).toEqual({ file, calls: null });
  }
});
