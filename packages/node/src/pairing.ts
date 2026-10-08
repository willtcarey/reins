/**
 * A remote node's identity on disk: pairing with a server (`reins node pair`) and reading the result back
 * (`reins node start`, later). See docs/plans/node-pairing.md *CLI*.
 *
 * The node home (`REINS_NODE_DATA_DIR`, default `~/.reins`, created 0700) holds `node.json`
 * (`NodeConfig`) and the node's Ed25519 private key, `keys/<nodeId>.pem` (PKCS#8 PEM, 0600). The server
 * knows only the public key, sent when the pairing code is redeemed.
 */
import { createPrivateKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { ReinsClient, ReinsHttpError, type ReinsClientOptions } from "@reins/client";
import { z } from "zod";

export const NODE_CONFIG_VERSION = 1;
/** How long redeeming a code may take before the server counts as unreachable. */
const PAIR_TIMEOUT_MS = 30_000;

const nodeConfigSchema = z.object({
  version: z.literal(NODE_CONFIG_VERSION),
  serverUrl: z.string(),
  nodeId: z.string(),
  keyPath: z.string(),
  sourceRoots: z.array(z.string()),
});
export type NodeConfig = z.infer<typeof nodeConfigSchema>;

/** The node ID names the key file, so it is held to characters safe in a path. */
const pairResponseSchema = z.object({ nodeId: z.string().regex(/^[\w-]+$/), name: z.string() });

/** What a paired node dials with: the server it belongs to and the key that proves it is this node. */
export interface NodeIdentity {
  nodeId: string;
  serverUrl: string;
  /** `new URL(serverUrl).origin`: the origin the node signs its challenge answers for. */
  origin: string;
  privateKey: KeyObject;
}

export interface PairOptions {
  /** The node home: `node.json` and `keys/`. */
  home: string;
  serverUrl: string;
  code: string;
  /** Replaces an existing pairing; without it, a home with a config is refused before anything is sent. */
  force?: boolean;
  /** Sent to the server, which names the node after it when the code was made without a name. `os.hostname()` by default. */
  hostname?: string;
  /** The client's transport (`globalThis.fetch` by default). */
  fetch?: ReinsClientOptions["fetch"];
}

/** Every outcome but an unexpected failure (a filesystem error, thrown). */
export type PairResult =
  | { status: "paired"; config: NodeConfig; configPath: string; name: string }
  /** The server URL is not an http(s) URL; nothing was sent. */
  | { status: "invalid_server_url" }
  /** The home has a config and `force` was not given; nothing was sent, so the code is still unused. */
  | { status: "already_paired"; configPath: string }
  /** The server refused the code (unknown, expired or used): its message. Nothing was written. */
  | { status: "refused"; message: string }
  /** No server answered, or not as a Reins server would. Nothing was written. */
  | { status: "unreachable"; message: string };

/**
 * Pairs the node home with a server: generates an Ed25519 keypair in memory, redeems `code` with its
 * public key, then writes the private key and, last, the config (a temp file renamed into place: the commit
 * point, so a failure never leaves a config pointing at a missing or wrong key). With `force`, the
 * previous pairing's key file is removed once the new config is in place.
 */
export async function pairNode(options: PairOptions): Promise<PairResult> {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  if (!serverUrl) return { status: "invalid_server_url" };
  const configPath = nodeConfigPath(options.home);
  if (!options.force && await Bun.file(configPath).exists()) return { status: "already_paired", configPath };
  // An unreadable previous config is replaced all the same; only its key file is then left behind.
  const previous = options.force ? await readNodeConfig(options.home).catch(() => null) : null;

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const client = new ReinsClient({ baseUrl: serverUrl, ...(options.fetch ? { fetch: options.fetch } : {}) });
  let paired: z.infer<typeof pairResponseSchema>;
  try {
    const response = await client.nodes.pair({
      code: options.code,
      publicKey: rawPublicKey(publicKey),
      hostname: options.hostname ?? osHostname(),
    }, { signal: AbortSignal.timeout(PAIR_TIMEOUT_MS) });
    const parsed = pairResponseSchema.safeParse(response);
    if (!parsed.success) return { status: "unreachable", message: `${serverUrl} answered the pairing request with an unexpected body` };
    paired = parsed.data;
  } catch (error) {
    if (error instanceof ReinsHttpError && error.status === 403) return { status: "refused", message: error.message };
    if (error instanceof ReinsHttpError) return { status: "unreachable", message: `${serverUrl} answered ${error.status}: ${error.message}` };
    return { status: "unreachable", message: `${serverUrl} did not answer: ${error instanceof Error ? error.message : String(error)}` };
  }

  const keysDir = join(options.home, "keys");
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  await mkdir(keysDir, { recursive: true, mode: 0o700 });
  const keyPath = join(keysDir, `${paired.nodeId}.pem`);
  const config: NodeConfig = { version: NODE_CONFIG_VERSION, serverUrl, nodeId: paired.nodeId, keyPath, sourceRoots: [] };
  await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  const tempPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tempPath, configPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    await rm(keyPath, { force: true });
    throw error;
  }
  if (previous && previous.keyPath !== keyPath) await rm(previous.keyPath, { force: true });
  return { status: "paired", config, configPath, name: paired.name };
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

/** The identity a paired node dials with: its config and its private key, read from `config.keyPath`. */
export async function loadNodeIdentity(config: NodeConfig): Promise<NodeIdentity> {
  const privateKey = createPrivateKey(await readFile(config.keyPath, "utf8"));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`Node key ${config.keyPath} is not an Ed25519 key`);
  return { nodeId: config.nodeId, serverUrl: config.serverUrl, origin: new URL(config.serverUrl).origin, privateKey };
}

function nodeConfigPath(home: string): string {
  return join(home, "node.json");
}

/** The server URL as stored: an http(s) URL without a trailing slash, query or fragment; null if it is not one. */
function normalizeServerUrl(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Base64url of the raw 32-byte Ed25519 public key (the JWK `x`), as the server stores it. */
function rawPublicKey(publicKey: KeyObject): string {
  const { x } = publicKey.export({ format: "jwk" });
  if (!x) throw new Error("Ed25519 public key has no x coordinate");
  return x;
}
