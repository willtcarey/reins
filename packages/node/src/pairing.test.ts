import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNodeConfig } from "./pairing.js";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function home() {
  const dir = mkdtempSync(join(tmpdir(), "reins-node-config-"));
  temps.push(dir);
  return dir;
}

test("reads a config with fields it does not know, and none at all as null", async () => {
  const dir = home();
  expect(await readNodeConfig(dir)).toBeNull();

  writeFileSync(join(dir, "node.json"), JSON.stringify({ version: 1, serverUrl: "https://reins.example", nodeId: "n1", keyPath: "/keys/n1.pem", sourceRoots: ["/src"], later: true }));

  expect(await readNodeConfig(dir)).toEqual({ version: 1, serverUrl: "https://reins.example", nodeId: "n1", keyPath: "/keys/n1.pem", sourceRoots: ["/src"] });
});

test("refuses a config of another version", async () => {
  const dir = home();
  writeFileSync(join(dir, "node.json"), JSON.stringify({ version: 2, serverUrl: "https://reins.example", nodeId: "n1", keyPath: "/keys/n1.pem", sourceRoots: [] }));

  await expect(readNodeConfig(dir)).rejects.toThrow("Unsupported node config version 2");
});
