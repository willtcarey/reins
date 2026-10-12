import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDevBundle } from "../dev-build.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** A checkout in miniature: an entry importing a local module, a workspace package (`@reins/fake`) and a
 * third-party package (`third`), the packages resolved through node_modules as in the repo. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "reins-dev-build-"));
  dirs.push(root);
  const workspaceSource = join(root, "node_modules/@reins/fake/src/value.ts");
  write(join(root, "node_modules/@reins/fake/package.json"), JSON.stringify({ name: "@reins/fake", type: "module", exports: { ".": "./src/value.ts" } }));
  write(workspaceSource, `import { third } from "third";\nexport const value = 1;\nexport const here = import.meta.dirname;\nexport { third };\n`);
  write(join(root, "node_modules/third/package.json"), JSON.stringify({ name: "third", type: "module", main: "index.js" }));
  write(join(root, "node_modules/third/index.js"), `export const third = Symbol("third");\n`);
  write(join(root, "node_modules/@reins/node-protocol/package.json"), JSON.stringify({ name: "@reins/node-protocol", type: "module", exports: { ".": "./index.ts" } }));
  write(join(root, "node_modules/@reins/node-protocol/index.ts"), `export class RpcFailure extends Error {}\n`);
  const localSource = join(root, "src/nodes/local.ts");
  write(localSource, `export const local = 1;\n`);
  const entry = join(root, "src/server.ts");
  write(entry, `export { value, here, third } from "@reins/fake";\nexport { local } from "./nodes/local.js";\nexport { readFileSync } from "node:fs";\nexport { RpcFailure } from "@reins/node-protocol";\n`);
  return { root, entry, workspaceSource, localSource, outdir: join(root, ".dev-build") };
}

test("the dev bundle includes local and workspace package code, so a rebuild picks up their changes, while the protocol and third-party packages stay one shared module", async () => {
  const { root, entry, workspaceSource, localSource, outdir } = fixture();
  await buildDevBundle(entry, outdir);
  const first = await import(`${join(outdir, "server.js")}?t=1`);
  expect(first.value).toBe(1);
  expect(first.local).toBe(1);
  const protocol = await import(join(root, "node_modules/@reins/node-protocol/index.ts"));
  expect(first.RpcFailure).toBe(protocol.RpcFailure);
  // Bundled sources keep their own location.
  expect(first.here).toBe(join(root, "node_modules/@reins/fake/src"));

  write(workspaceSource, `import { third } from "third";\nexport const value = 2;\nexport const here = import.meta.dirname;\nexport { third };\n`);
  write(localSource, `export const local = 2;\n`);
  await buildDevBundle(entry, outdir);
  const second = await import(`${join(outdir, "server.js")}?t=2`);
  expect(second.value).toBe(2);
  expect(second.local).toBe(2);
  expect(second.third).toBe(first.third);
  expect(second.RpcFailure).toBe(first.RpcFailure);
  expect(second.readFileSync).toBe((await import("node:fs")).readFileSync);
});

test("the real server bundle shares the protocol, bundles every local source (node hub and database included) and contains no node implementation", async () => {
  const outdir = mkdtempSync(join(tmpdir(), "reins-dev-build-server-"));
  dirs.push(outdir);
  await buildDevBundle(new URL("../server.ts", import.meta.url).pathname, outdir);
  const bundle = await Bun.file(join(outdir, "server.js")).text();
  expect(bundle).toMatch(/from\s*"@reins\/node-protocol"/);
  expect(bundle.includes("function createRpcPeer(")).toBe(false); // one process-lifetime protocol instance
  expect(bundle.includes("function createNodeHub(")).toBe(true);
  expect(bundle.includes("function getDb(")).toBe(true);
  expect(bundle).not.toMatch(/from\s*"file:/);
  expect(bundle).not.toMatch(/^\/\/ (?:\.\.\/)*node\/src\//m); // nothing from @reins/node
  expect(bundle).toMatch(/from\s*"@earendil-works\/pi-coding-agent"/);
  expect(bundle).toMatch(/from\s*"zod"/);
  expect(bundle.includes("import.meta.url")).toBe(false);
}, 30_000);
