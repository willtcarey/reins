/** Node authentication: the server-first `node.authenticate` challenge an authenticating connection
 * answers (docs/dev/node-transport.md *Details: authentication*), the Ed25519 signature that answers it,
 * and the node key's wire encoding. A paired node holds its private key; the server holds the public key
 * it was paired with, encoded as `encodeNodePublicKey` does. */
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { id } from "./fields.js";

/** Domain separation for the signed bytes: a signature made for this protocol is valid for nothing else. */
const NODE_AUTH_DOMAIN = "reins-node-auth-v1";
const NONCE_BYTES = 32;
const base64url = z.string().regex(/^[A-Za-z0-9_-]*$/);

// Tolerant (`z.object`): the challenge is bootstrap surface, which changes only additively.
export const authenticateParams = z.object({
  challengeId: z.string().uuid(),
  /** 32 random bytes, base64url. */
  nonce: base64url.length(43),
});
export const authenticateResult = z.object({
  nodeId: id,
  /** Ed25519 signature of `nodeAuthMessage`, base64url. */
  signature: base64url.max(512),
});
export type NodeChallenge = z.infer<typeof authenticateParams>;
export type NodeAnswer = z.infer<typeof authenticateResult>;

/** What a paired node signs its challenges with: the server origin it dialed (`new URL(serverUrl).origin`)
 * and its private key. */
export interface NodeIdentity { origin: string; privateKey: KeyObject }

/** A new node key: the private key the node keeps, and its public key encoded for the server. */
export function generateNodeKeyPair(): { publicKey: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: encodeNodePublicKey(publicKey), privateKey };
}

/** The public key of an Ed25519 key (public or private) as the server stores it: base64url of the raw 32
 * bytes (the JWK `x`). */
export function encodeNodePublicKey(key: KeyObject): string {
  const { x } = (key.type === "private" ? createPublicKey(key) : key).export({ format: "jwk" });
  if (!x) throw new Error("Not an Ed25519 key");
  return x;
}

/** The Ed25519 public key `encoded` holds, or null unless it is exactly what `encodeNodePublicKey` makes
 * (canonical, so one key has one spelling and binds at most one node). */
export function parseNodePublicKey(encoded: string): KeyObject | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded) || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) return null;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: encoded }, format: "jwk" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

/** A fresh challenge for one connection. */
export function newNodeChallenge(): NodeChallenge {
  return { challengeId: randomUUID(), nonce: randomBytes(NONCE_BYTES).toString("base64url") };
}

/** The bytes a node signs: they bind the answer to this protocol, the server origin, the node and the challenge. */
function nodeAuthMessage(origin: string, nodeId: string, { challengeId, nonce }: NodeChallenge): Buffer {
  return Buffer.from(JSON.stringify([NODE_AUTH_DOMAIN, origin, nodeId, challengeId, nonce]), "utf8");
}

/** Node `nodeId`'s answer to `challenge`. */
export function signNodeChallenge({ origin, privateKey }: NodeIdentity, nodeId: string, challenge: NodeChallenge): NodeAnswer {
  return { nodeId, signature: sign(null, nodeAuthMessage(origin, nodeId, challenge), privateKey).toString("base64url") };
}

/** Whether `answer` is the signature, by `publicKey`'s private key, of `challenge` for `answer.nodeId` at
 * `origin`. False for a malformed key or signature. */
export function verifyNodeAnswer({ publicKey, origin, challenge, answer }: { publicKey: string; origin: string; challenge: NodeChallenge; answer: NodeAnswer }): boolean {
  const key = parseNodePublicKey(publicKey);
  if (!key) return false;
  try {
    return verify(null, nodeAuthMessage(origin, answer.nodeId, challenge), key, Buffer.from(answer.signature, "base64url"));
  } catch {
    return false;
  }
}
