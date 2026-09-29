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
  const entry = join(root, "src/server.ts");
  write(entry, `export { value, here, third } from "@reins/fake";\nexport { readFileSync } from "node:fs";\n`);
  return { root, entry, workspaceSource, outdir: join(root, ".dev-build") };
}

test("the dev bundle includes workspace package code, so a rebuild picks up its changes, while third-party packages stay one shared module", async () => {
  const { root, entry, workspaceSource, outdir } = fixture();
  await buildDevBundle(entry, outdir);
  const first = await import(`${join(outdir, "server.js")}?t=1`);
  expect(first.value).toBe(1);
  // Bundled sources keep their own location.
  expect(first.here).toBe(join(root, "node_modules/@reins/fake/src"));

  write(workspaceSource, `import { third } from "third";\nexport const value = 2;\nexport const here = import.meta.dirname;\nexport { third };\n`);
  await buildDevBundle(entry, outdir);
  const second = await import(`${join(outdir, "server.js")}?t=2`);
  expect(second.value).toBe(2);
  expect(second.third).toBe(first.third);
  expect(second.readFileSync).toBe((await import("node:fs")).readFileSync);
});

test("the real server bundle inlines the shared @reins packages, contains no node code and keeps third-party packages external", async () => {
  const outdir = mkdtempSync(join(tmpdir(), "reins-dev-build-server-"));
  dirs.push(outdir);
  await buildDevBundle(new URL("../server.ts", import.meta.url).pathname, outdir);
  const bundle = await Bun.file(join(outdir, "server.js")).text();
  expect(bundle).not.toMatch(/from\s*"@reins\//);
  expect(bundle.includes("function createRpcPeer(")).toBe(true); // @reins/node-protocol, inlined
  expect(bundle).not.toMatch(/^\/\/ (?:\.\.\/)*node\/src\//m); // nothing from @reins/node
  expect(bundle).toMatch(/from\s*"@earendil-works\/pi-coding-agent"/);
  expect(bundle).toMatch(/from\s*"zod"/);
  expect(bundle.includes("import.meta.url")).toBe(false);
}, 30_000);
