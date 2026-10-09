import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNodeConfig, saveNodeIdentity, writeNodeConfig } from "./config.js";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function home() {
  const dir = mkdtempSync(join(tmpdir(), "reins-node-config-"));
  temps.push(dir);
  return dir;
}

/** Every file under `dir`, by relative path, with its contents. */
function files(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" }).toSorted();
  return Object.fromEntries(entries.filter(entry => statSync(join(dir, entry)).isFile()).map(entry => [entry, readFileSync(join(dir, entry), "utf8")]));
}

const privateKey = () => generateKeyPairSync("ed25519").privateKey;
const config = { version: 1 as const, serverUrl: "https://reins.example", nodeId: "n1", keyPath: "/keys/n1.pem", sourceRoots: ["/src"] };

test("reads no config as null, and writes one (0600) that reads back", async () => {
  const dir = home();
  expect(await readNodeConfig(dir)).toBeNull();

  const path = await writeNodeConfig(dir, config);

  expect(path).toBe(join(dir, "node.json"));
  expect(await readNodeConfig(dir)).toEqual(config);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir)).toEqual(["node.json"]);
});

test("keeps fields it does not know through a read and a write", async () => {
  const dir = home();
  writeFileSync(join(dir, "node.json"), JSON.stringify({ ...config, later: { added: true } }));

  const read = await readNodeConfig(dir);
  await writeNodeConfig(dir, { ...read!, sourceRoots: ["/src", "/more"] });

  expect(JSON.parse(readFileSync(join(dir, "node.json"), "utf8"))).toEqual({ ...config, sourceRoots: ["/src", "/more"], later: { added: true } });
});

test("refuses a config of another version", async () => {
  const dir = home();
  writeFileSync(join(dir, "node.json"), JSON.stringify({ ...config, version: 2 }));

  await expect(readNodeConfig(dir)).rejects.toThrow("Unsupported node config version 2");
});

test("a pairing whose config cannot be written leaves the previous one as it was, without the new key", async () => {
  const dir = join(home(), "home");
  await saveNodeIdentity(dir, { serverUrl: "https://reins.example", nodeId: "first", privateKey: privateKey() });
  const before = files(dir);
  chmodSync(dir, 0o500);

  await expect(saveNodeIdentity(dir, { serverUrl: "https://reins.example", nodeId: "second", privateKey: privateKey() })).rejects.toThrow();

  chmodSync(dir, 0o700);
  expect(files(dir)).toEqual(before);
});

test("refuses a node ID that is not safe in a path, writing nothing", async () => {
  const dir = join(home(), "home");

  await expect(saveNodeIdentity(dir, { serverUrl: "https://reins.example", nodeId: "../escape", privateKey: privateKey() })).rejects.toThrow("Node ID");

  expect(existsSync(dir)).toBe(false);
});
