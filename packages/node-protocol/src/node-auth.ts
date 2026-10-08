/** Node authentication: the server-first `node.authenticate` challenge an authenticating connection
 * answers before `node.hello`, and the Ed25519 signature that answers it (docs/dev/node-transport.md
 * *Details: authentication*). A paired node holds its private key; the server holds the public key it was paired
 * with (base64url of the raw 32 bytes). */
import { createPublicKey, randomBytes, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { id } from "./fields.js";

/** Domain separation for the signed bytes: a signature made for this protocol is valid for nothing else. */
export const NODE_AUTH_DOMAIN = "reins-node-auth-v1";
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

/** What a paired node dials with: its ID, the server origin it dialed (`new URL(serverUrl).origin`) and its key. */
export interface NodeIdentity { nodeId: string; origin: string; privateKey: KeyObject }

/** A fresh challenge for one connection. */
export function newNodeChallenge(): NodeChallenge {
  return { challengeId: randomUUID(), nonce: randomBytes(NONCE_BYTES).toString("base64url") };
}

/** The bytes a node signs: they bind the answer to this protocol, the server origin, the node and the challenge. */
function nodeAuthMessage(origin: string, nodeId: string, { challengeId, nonce }: NodeChallenge): Buffer {
  return Buffer.from(JSON.stringify([NODE_AUTH_DOMAIN, origin, nodeId, challengeId, nonce]), "utf8");
}

export function signNodeChallenge(identity: NodeIdentity, challenge: NodeChallenge): NodeAnswer {
  return { nodeId: identity.nodeId, signature: sign(null, nodeAuthMessage(identity.origin, identity.nodeId, challenge), identity.privateKey).toString("base64url") };
}

/** Whether `answer` is the signature, by `publicKey`'s private key, of `challenge` for `answer.nodeId` at
 * `origin`. False for a malformed key or signature. */
export function verifyNodeAnswer({ publicKey, origin, challenge, answer }: { publicKey: string; origin: string; challenge: NodeChallenge; answer: NodeAnswer }): boolean {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    return verify(null, nodeAuthMessage(origin, answer.nodeId, challenge), key, Buffer.from(answer.signature, "base64url"));
  } catch {
    return false;
  }
}
