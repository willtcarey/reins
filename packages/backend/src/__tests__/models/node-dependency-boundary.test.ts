import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const source = (path: string) => Bun.file(new URL(path, root)).text();
const packageDir = (name: string) => new URL(`../../../../${name}/src/`, import.meta.url);
/** Every non-test source of a package with its import specifiers. */
async function packageImports(name: string): Promise<Array<{ file: string; specifiers: string[] }>> {
  const dir = packageDir(name);
  const files = (await readdir(dir, { recursive: true })).filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  return Promise.all(files.map(async file => {
    const text = await Bun.file(new URL(file, dir)).text();
    return { file, specifiers: [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1] ?? match[2]!) };
  }));
}

test("node and protocol code cannot import server state, DB, session or source tables", async () => {
  for (const name of ["node", "node-protocol"]) {
    for (const { file, specifiers } of await packageImports(name)) {
      expect({ file, server: specifiers.filter(specifier => /backend|server-state|session-store|node-store|\/db\./.test(specifier)) }).toEqual({ file, server: [] });
    }
  }
});

test("server production code imports nothing from @reins/node", async () => {
  const files = (await readdir(root, { recursive: true }))
    .filter(name => name.endsWith(".ts") && !name.startsWith("__tests__/"));
  expect(files).toContain("routes/skills.ts");
  for (const file of files) {
    expect({ file, node: (await source(file)).match(/@reins\/node(?:\/|["'])/g) }).toEqual({ file, node: null });
  }
});

test("@reins/node-protocol imports only zod, itself and runtime builtins", async () => {
  for (const { file, specifiers } of await packageImports("node-protocol")) {
    expect({ file, external: specifiers.filter(specifier => !(specifier === "zod" || specifier.startsWith("./") || specifier.startsWith("node:") || specifier === "bun")) }).toEqual({ file, external: [] });
  }
});

test("no server code singles out a node: the seeded node's ID is data (its migration), never a branch", async () => {
  const files = (await readdir(root, { recursive: true }))
    .filter(name => name.endsWith(".ts") && !name.startsWith("__tests__/") && !name.endsWith(".test.ts") && name !== "migrations.ts");
  for (const file of files) {
    const text = await source(file);
    expect({ file, special: text.match(/INTERNAL_NODE_ID|node_id\s*=\s*'internal'|(?:===|!==|==)\s*["']internal["']|["']internal["']\s*(?:===|!==|==)|nodeId:\s*["']internal["']/g) }).toEqual({ file, special: null });
  }
});

test("server code never starts a node (only tests link an in-process node)", async () => {
  const files = (await readdir(root, { recursive: true }))
    .filter(name => name.endsWith(".ts") && !name.startsWith("__tests__/") && !name.endsWith(".test.ts"));
  expect(files).toContain("server-process.ts");
  for (const file of files) {
    const text = await source(file);
    // The node runtime, its connection and dialer, and the link's test doubles.
    expect({ file, imports: text.match(/from\s+["']@reins\/(?:node\/(?:node|node-connection|local-link)|node-protocol\/testing)["']/g) }).toEqual({ file, imports: null });
    expect({ file, calls: text.match(/\b(?:startNode|createLoopbackPair)\s*\(/g) }).toEqual({ file, calls: null });
  }
});
