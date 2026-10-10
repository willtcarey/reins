/**
 * A paired node's identity on disk, written by `reins node pair` (pair.ts) and read back by
 * `reins node start` (later). See docs/dev/node-contract.md *Pairing and authentication*.
 *
 * The node home (`nodeHome()` in `@reins/node/node-home`: `REINS_NODE_DATA_DIR`, default `~/.reins`,
 * created 0700) holds `node.json` (`NodeConfig`, 0600) and the node's Ed25519 private key,
 * `keys/<nodeId>.pem` (PKCS#8 PEM, 0600; the config names it). The server knows only the public key.
 * Nothing outside this module knows the layout.
 */
import { createPrivateKey, randomUUID, type KeyObject } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeIdentity } from "@reins/node-protocol";
import { z } from "zod";

export const NODE_CONFIG_VERSION = 1;

/** Loose: fields it does not know (written by a newer CLI of the same version) are kept, so a read and
 * a write never erase them. */
const nodeConfigSchema = z.looseObject({
  version: z.literal(NODE_CONFIG_VERSION),
  serverUrl: z.string(),
  nodeId: z.string(),
  keyPath: z.string(),
  sourceRoots: z.array(z.string()),
});
export type NodeConfig = z.infer<typeof nodeConfigSchema>;

/** A node ID as the server assigns it. It names the key file, so it is held to characters safe in a path. */
export const nodeIdSchema = z.string().regex(/^[\w-]+$/);

export function nodeConfigPath(home: string): string {
  return join(home, "node.json");
}

/** Whether the home has a config, readable or not: a pairing to keep unless replaced on purpose. */
export function hasNodeConfig(home: string): Promise<boolean> {
  return Bun.file(nodeConfigPath(home)).exists();
}

/** The home's config, or null when it has none. Throws on a config that is not JSON or not of this version. */
export async function readNodeConfig(home: string): Promise<NodeConfig | null> {
  const path = nodeConfigPath(home);
  const file = Bun.file(path);
  if (!await file.exists()) return null;
  let json: unknown;
  try { json = JSON.parse(await file.text()); } catch { throw new Error(`Node config ${path} is not JSON`); }
  const version = typeof json === "object" && json !== null && "version" in json ? json.version : undefined;
  if (version !== NODE_CONFIG_VERSION) throw new Error(`Unsupported node config version ${String(version)} in ${path} (expected ${NODE_CONFIG_VERSION})`);
  const parsed = nodeConfigSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid node config ${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Replaces the config of an existing home: a temp file (0600) renamed into place, so a reader sees the
 * old config or the new one, never part of one. Resolves with the config's path. */
export async function writeNodeConfig(home: string, config: NodeConfig): Promise<string> {
  const path = nodeConfigPath(home);
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return path;
}

/**
 * Saves a new pairing: creates the home and `keys/` (0700), writes the private key to a new
 * `keys/<nodeId>.pem` (0600) and then the config, the commit point (`writeNodeConfig`), so a failure never
 * leaves a config naming a missing or wrong key: the new key is removed again if the config is not
 * written. The previous pairing's key, if the home had one, is removed once the new config is in place
 * (an unreadable previous config is replaced all the same; only its key file is then left behind).
 */
export async function saveNodeIdentity(home: string, identity: { serverUrl: string; nodeId: string; privateKey: KeyObject }): Promise<{ config: NodeConfig; configPath: string }> {
  const { serverUrl, nodeId, privateKey } = identity;
  if (!nodeIdSchema.safeParse(nodeId).success) throw new Error("Node ID is not safe in a file name");
  const previous = await readNodeConfig(home).catch(() => null);
  const keysDir = join(home, "keys");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(keysDir, { recursive: true, mode: 0o700 });
  const keyPath = join(keysDir, `${nodeId}.pem`);
  const config: NodeConfig = { version: NODE_CONFIG_VERSION, serverUrl, nodeId, keyPath, sourceRoots: [] };
  await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  let configPath: string;
  try {
    configPath = await writeNodeConfig(home, config);
  } catch (error) {
    await rm(keyPath, { force: true });
    throw error;
  }
  if (previous && previous.keyPath !== keyPath) await rm(previous.keyPath, { force: true });
  return { config, configPath };
}

/** The identity a paired node dials `config.serverUrl` with as `config.nodeId` (`connectNode`'s
 * `identity`): the server's origin and the private key read from `config.keyPath`. */
export async function loadNodeIdentity(config: NodeConfig): Promise<NodeIdentity> {
  const privateKey = createPrivateKey(await readFile(config.keyPath, "utf8"));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`Node key ${config.keyPath} is not an Ed25519 key`);
  return { origin: new URL(config.serverUrl).origin, privateKey };
}
