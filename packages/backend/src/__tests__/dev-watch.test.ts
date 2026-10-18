import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchDevSources, type DevWatcher } from "../dev-watch.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** A server's sources in miniature: the process's entry importing a process-owned module and the app, and
 * the protocol's sources; watched as the dev server watches its own, with what it asked recorded. */
function watched(options: { restarts?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "reins-dev-watch-"));
  const srcDir = join(root, "src");
  const protocolDir = join(root, "node-protocol/src");
  write(join(srcDir, "index.ts"), `import { owned } from "./owned.js";\nexport const app = () => import("./server.js");\nexport { owned };\n`);
  write(join(srcDir, "owned.ts"), `export const owned = 1;\n`);
  write(join(srcDir, "server.ts"), `export const app = 1;\n`);
  write(join(protocolDir, "index.ts"), `export const version = 1;\n`);
  const reloads: string[] = [];
  const restarts: string[] = [];
  const logged: string[] = [];
  const watcher: DevWatcher = watchDevSources({
    srcDir,
    processOwned: new Set(["index.ts", "owned.ts", "process-owned.json"]),
    processEntry: join(srcDir, "index.ts"),
    packages: [],
    protocol: { name: "@reins/node-protocol", dir: protocolDir },
    reload: async what => { reloads.push(what); },
    restart: options.restarts === false ? undefined : what => { restarts.push(what); },
    log: { info: message => logged.push(`info: ${message}`), warn: message => logged.push(`warn: ${message}`), error: message => logged.push(`error: ${message}`) },
  });
  cleanups.push(() => { watcher.close(); rmSync(root, { recursive: true, force: true }); });
  return { srcDir, protocolDir, reloads, restarts, logged };
}

const settle = () => Bun.sleep(400);

test("an app source edit reloads the app; a process-owned edit restarts the process instead, once for a burst of edits written together, after its new code builds", async () => {
  const { srcDir, reloads, restarts } = watched();
  write(join(srcDir, "server.ts"), `export const app = 2;\n`);
  await settle();
  expect(reloads).toEqual(["server.ts reloaded"]);
  expect(restarts).toEqual([]);

  write(join(srcDir, "server.ts"), `export const app = 3;\n`);
  write(join(srcDir, "owned.ts"), `export const owned = 2;\n`);
  write(join(srcDir, "owned.ts"), `export const owned = 3;\n`);
  await settle();
  expect(restarts).toEqual(["owned.ts changed"]);
  expect(reloads).toEqual(["server.ts reloaded"]);
});

test("a process-owned edit whose code does not build leaves the process running, with the build error logged, until an edit that builds", async () => {
  const { srcDir, restarts, logged } = watched();
  write(join(srcDir, "owned.ts"), `export const owned = ;\n`);
  await settle();
  expect(restarts).toEqual([]);
  expect(logged.some(line => line.startsWith("error: ") && line.includes("owned.ts changed") && line.includes("the server keeps running"))).toBe(true);

  // An app source the process imports is checked too: the new process would start it.
  write(join(srcDir, "owned.ts"), `export const owned = 4;\n`);
  write(join(srcDir, "server.ts"), `export const app = ;\n`);
  await settle();
  expect(restarts).toEqual([]);

  write(join(srcDir, "server.ts"), `export const app = 4;\n`);
  write(join(srcDir, "owned.ts"), `export const owned = 5;\n`);
  await settle();
  expect(restarts).toEqual(["owned.ts changed"]);
});

test("without a supervisor to restart it, a process-owned edit is only warned about", async () => {
  const { srcDir, reloads, logged } = watched({ restarts: false });
  write(join(srcDir, "owned.ts"), `export const owned = 2;\n`);
  await settle();
  expect(reloads).toEqual([]);
  expect(logged.length).toBeGreaterThan(0);
  for (const line of logged) expect(line).toMatch(/^warn: .*owned\.ts: process-owned code changed; restart the server to apply it/);
});

test("a protocol edit is only warned about, and process-owned edits after it no longer restart the process alone: server and node must restart together", async () => {
  const { srcDir, protocolDir, reloads, restarts, logged } = watched();
  write(join(protocolDir, "index.ts"), `export const version = 2;\n`);
  await settle();
  expect(logged.length).toBeGreaterThan(0);
  for (const line of logged) expect(line).toMatch(/^warn: .*@reins\/node-protocol index\.ts: protocol code changed; restart the server and node together/);

  write(join(srcDir, "owned.ts"), `export const owned = 2;\n`);
  await settle();
  expect(restarts).toEqual([]);
  expect(reloads).toEqual([]);
  expect(logged.at(-1)).toMatch(/^warn: .*owned\.ts changed: process-owned code changed, but so did @reins\/node-protocol/);
});
