import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { buildDevBundle, restartRequired, WORKSPACE_SCOPE } from "../dev-build.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** A checkout in miniature: an entry importing a workspace package (`@reins/fake`) and a third-party
 * package (`third`), both resolved through node_modules as in the repo. */
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
  const entry = join(root, "src/server.ts");
  write(entry, `export { value, here, third } from "@reins/fake";\nexport { readFileSync } from "node:fs";\nexport { RpcFailure } from "@reins/node-protocol";\n`);
  return { root, entry, workspaceSource, outdir: join(root, ".dev-build") };
}

test("the dev bundle includes workspace package code, so a rebuild picks up its changes, while third-party packages stay one shared module", async () => {
  const { root, entry, workspaceSource, outdir } = fixture();
  await buildDevBundle(entry, outdir);
  const first = await import(`${join(outdir, "server.js")}?t=1`);
  expect(first.value).toBe(1);
  const protocol = await import(join(root, "node_modules/@reins/node-protocol/index.ts"));
  expect(first.RpcFailure).toBe(protocol.RpcFailure);
  // Bundled sources keep their own location.
  expect(first.here).toBe(join(root, "node_modules/@reins/fake/src"));

  write(workspaceSource, `import { third } from "third";\nexport const value = 2;\nexport const here = import.meta.dirname;\nexport { third };\n`);
  await buildDevBundle(entry, outdir);
  const second = await import(`${join(outdir, "server.js")}?t=2`);
  expect(second.value).toBe(2);
  expect(second.third).toBe(first.third);
  expect(second.RpcFailure).toBe(first.RpcFailure);
  expect(second.readFileSync).toBe((await import("node:fs")).readFileSync);
});

test("process-owned database access and delivery deferrals keep their identity across handler reloads", async () => {
  const root = mkdtempSync(new URL("../../.dev-build-test-", import.meta.url).pathname);
  dirs.push(root);
  const entry = join(root, "entry.ts");
  write(entry, `export { DeliveryDeferred } from "@reins/node-protocol";\nexport { getDb } from "../src/db.js";`);
  await buildDevBundle(entry, root);
  const bundle = await Bun.file(join(root, "entry.js")).text();
  expect(bundle.includes("function getDb(")).toBe(false);
  const first = await import(`${join(root, "entry.js")}?t=1`);
  const second = await import(`${join(root, "entry.js")}?t=2`);
  const { DeliveryDeferred } = await import("@reins/node-protocol");
  expect(first.getDb).toBe((await import("../db.js")).getDb);
  expect(second.getDb).toBe(first.getDb);
  expect(new first.DeliveryDeferred("offline")).toBeInstanceOf(DeliveryDeferred);
  expect(second.DeliveryDeferred).toBe(first.DeliveryDeferred);
});

test("process-owned sources import only process-owned code, so a handler reload never leaves them a stale copy", async () => {
  const src = join(import.meta.dirname, "..");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const sources = (await Array.fromAsync(new Bun.Glob("**/*.ts").scan(src)))
    .filter(path => !path.startsWith("__tests__/") && restartRequired(path));
  expect(sources).toContain("node-link/node-hub.ts");
  const leaks: string[] = [];
  for (const source of sources) {
    // Type-only imports are erased; dynamic imports (the handler bundle) are loaded fresh.
    const imports = transpiler.scanImports(await Bun.file(join(src, source)).text()).filter(entry => entry.kind === "import-statement");
    for (const { path } of imports) {
      if (path.startsWith(".")) {
        const target = relative(src, resolve(dirname(join(src, source)), path.replace(/\.js$/, ".ts")));
        // Migrations run once, when the database opens at process startup.
        if (!restartRequired(target) && target !== "migrations.ts") leaks.push(`${source} → ${target}`);
      } else if (path.startsWith(WORKSPACE_SCOPE) && path !== "@reins/node-protocol") {
        leaks.push(`${source} → ${path}`);
      }
    }
  }
  expect(leaks).toEqual([]);
});

test("the real server bundle shares process-owned protocol code, bundles product code and contains no node implementation", async () => {
  const outdir = mkdtempSync(join(tmpdir(), "reins-dev-build-server-"));
  dirs.push(outdir);
  await buildDevBundle(new URL("../server.ts", import.meta.url).pathname, outdir);
  const bundle = await Bun.file(join(outdir, "server.js")).text();
  expect(bundle).toMatch(/from\s*"@reins\/node-protocol"/);
  expect(bundle.includes("function createRpcPeer(")).toBe(false); // one process-lifetime protocol instance
  expect(bundle.includes("function getDb(")).toBe(false);
  expect(bundle).toMatch(/from\s*"file:\/\/[^"\n]+\/node-command-store\.ts"/);
  expect(bundle).not.toMatch(/^\/\/ (?:\.\.\/)*node\/src\//m); // nothing from @reins/node
  expect(bundle).toMatch(/from\s*"@earendil-works\/pi-coding-agent"/);
  expect(bundle).toMatch(/from\s*"zod"/);
  expect(bundle.includes("import.meta.url")).toBe(false);
}, 30_000);
